#!/usr/bin/env node
// A paying customer of a Outlive relay in one file. See docs/TRY-AS-CUSTOMER.md.
//
//   node examples/customer.mjs --account you.testnet                 1. ask without credit: HTTP 402
//   node examples/customer.mjs --account you.testnet --fund 2        2. mint 2 tUSDC, prepay, deliver
//   node examples/customer.mjs --account you.testnet --refund        3. start the refund delay
//   node examples/customer.mjs --account you.testnet --claim         4. after the delay: money back
//
// Options: --vault (default relay-live.outlive.testnet), --target (a public URL that
// accepts POST; default https://httpbin.org/post). The endpoint is read from the vault on chain.
// Your key is read from the near-cli legacy keychain (~/.near-credentials/testnet/<account>.json)
// and never printed. Run `npm ci && npm run build` once in the repository first.

import path from "node:path";
import { parseArgs } from "node:util";
import { OutliveClient, PaymentRequiredError, Rpc, TESTNET_RPC_URLS, VaultViews, formatUnits, fromUnits, signerFromSecretKey, verifyProof } from "../sdk/dist/src/index.js";
import { NodeSigner, createNodeTransactor, fileStore, keychainFile, readKeyFile } from "../sdk/dist/src/node.js";

const MAX_MINT = 5; // tUSDC: plenty for hundreds of calls at 0.01; the token allows more, do not.
const { values: o } = parseArgs({
  options: {
    account: { type: "string" },
    vault: { type: "string", default: "relay-live.outlive.testnet" },
    target: { type: "string", default: "https://httpbin.org/post" },
    fund: { type: "string" },
    refund: { type: "boolean", default: false },
    claim: { type: "boolean", default: false },
  },
});
if (!o.account) throw new Error("usage: node examples/customer.mjs --account <you.testnet> [--fund <tUSDC>] [--refund] [--claim]");
const rpc = new Rpc(process.env.NEAR_RPC_URLS ? process.env.NEAR_RPC_URLS.split(",") : TESTNET_RPC_URLS);
const key = readKeyFile(keychainFile(o.account)).private_key;
const chainSigner = new NodeSigner(o.account, key, rpc.urls);
const client = new OutliveClient({
  vault: o.vault,
  accountId: o.account,
  signer: signerFromSecretKey(key), // NEP-413: every request is signed with your full-access key
  rpc,
  transactor: createNodeTransactor(chainSigner),
  store: fileStore(path.join("examples", ".receipts", `${o.account}.json`)), // receipts survive restarts
});
const info = await new VaultViews(rpc, o.vault).info();
const fmt = (v) => `${formatUnits(v, 6)} tUSDC`;
const link = (h) => `https://testnet.nearblocks.io/txns/${h}`;
console.log(`vault ${o.vault}: endpoint on chain ${info.endpoint}, price ${fmt(info.price_per_call)} per call, first deposit at least ${fmt(info.min_deposit)}`);

if (o.refund || o.claim) {
  const out = o.refund ? await client.requestRefund() : await client.claimRefund();
  console.log(`${o.refund ? "request_refund" : "claim_refund"}: ${out.success ? "ok" : `failed ${out.error}`} ${link(out.hash)}`);
  const me = await client.customer();
  console.log(me ? `credit ${fmt(me.balance)}, refund available at ${me.refund_available_at_ms ? new Date(Number(me.refund_available_at_ms)).toISOString() : "-"}` : "no credit left in this vault");
  process.exit(0);
}

if (o.fund) {
  const amount = fromUnits(o.fund, 6);
  if (amount > fromUnits(String(MAX_MINT), 6)) throw new Error(`--fund at most ${MAX_MINT}`);
  if (!(await rpc.view(info.payment_token, "storage_balance_of", { account_id: o.account }))) {
    const reg = await chainSigner.call(info.payment_token, { method: "storage_deposit", args: { account_id: o.account, registration_only: true }, gasTgas: 30, depositYocto: 1_250_000_000_000_000_000_000n });
    console.log(`storage_deposit on ${info.payment_token}: ${reg.success ? "ok" : "failed"} ${link(reg.hash)}`);
  }
  const mint = await chainSigner.call(info.payment_token, { method: "mint", args: { amount: amount.toString() }, gasTgas: 30, depositYocto: 0n });
  console.log(`mint ${fmt(amount)} (public test faucet): ${mint.success ? "ok" : "failed"} ${link(mint.hash)}`);
  const top = await client.topUp(amount);
  console.log(`ft_transfer_call ${fmt(amount)} to the vault as prepaid credit: ${top.success ? "ok" : `failed ${top.error}`} ${link(top.hash)}`);
}

const request = { url: o.target, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hello: "from a Outlive customer", at: new Date().toISOString() }), idempotency_key: `try-${Date.now()}` };
try {
  const { delivery_id, receipt } = await client.deliver(request);
  console.log(`202 accepted ${delivery_id}: receipt seq ${receipt.payload.seq}, price ${fmt(receipt.payload.price)}, signed by worker key ${receipt.payload.worker_public_key} (checked against the vault's worker keys)`);
  for (let i = 0; i < 30 && client.pendingCount() > 0; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    await client.track();
  }
  const s = await client.status(delivery_id);
  for (const p of s.attempts) console.log(`attempt ${p.payload.attempt}: HTTP ${p.payload.status_code}, response sha256 ${p.payload.response_sha256.slice(0, 16)}..., proof signature ${verifyProof(p) ? "valid" : "INVALID"}`);
  console.log(`state: ${s.state}`);
} catch (e) {
  if (!(e instanceof PaymentRequiredError)) throw e;
  console.log(`402 payment required (${e.details.reason}). The worker says how to pay:`);
  console.log(JSON.stringify(e.details.how_to_pay, null, 2));
  console.log("Run again with --fund 2 to mint test tUSDC and prepay.");
}
