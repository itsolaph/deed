#!/usr/bin/env node
// Wash-revenue rejection on testnet: a seller pays its own vault through two fresh accounts it
// funded itself, lists the deed, and the buyer agent (even with the relaxed demo policy) skips
// it because revenue from owner-funded customers is excluded.
//
//   1. the seller mints a new deed and registers worker A (local, 127.0.0.1)
//   2. the seller creates two fresh top-level accounts and funds them:
//      - customer 1 gets tUSDC by ft_transfer from the seller and deposits it itself
//      - customer 2 gets its credit deposited by the seller (ft_transfer_call, deposit_for)
//   3. both send paid deliveries through the worker; the worker charges them
//   4. the seller lists the deed
//   5. the buyer agent runs with --policy demo --dry-run and must answer SKIP with
//      "revenue from owner-funded customers excluded"
//   6. the listing is cancelled again so the wash deed is not shown as for sale
//
// Environment: WASH_SELLER (a fresh faucet account with about 4 NEAR; default DEMO_SELLER),
// DEMO_BUYER, WASH_SLUG (default wash-<MMDDHHMM>), WASH_PORT (7605), WASH_ECHO_PORT (7613),
// NEAR_RPC_URLS, NEAR_CREDENTIALS_DIR. Takes about 4 minutes. Recorded in
// deployments/testnet.json under "washReject". Keys stay in the legacy keychain, never printed.

import "./lib/env.mjs";
import path from "node:path";
import { loadDeployments, saveDeployments } from "./lib/deployments.mjs";
import { NEAR, ONE_YOCTO, TGAS, account, addressLink, call, credentialsDir, newKeyPair, saveKeyPair, view } from "./lib/near.mjs";
import { buildPackages, createRun, portsFree, retrySend, sleep, stamp, waitHealth } from "./lib/run.mjs";

const PORT = Number(process.env.WASH_PORT || 7605);
const ECHO_PORT = Number(process.env.WASH_ECHO_PORT || 7613);
const SLUG = process.env.WASH_SLUG || `wash-${stamp()}`;
const dep = loadDeployments();
const SELLER = process.env.WASH_SELLER || process.env.DEMO_SELLER || dep.accounts.seller;
const BUYER = process.env.DEMO_BUYER || dep.accounts.buyer;
const DEED = dep.accounts.deed;
const TUSDC = dep.accounts.tusdc;
const VAULT = `${SLUG}.${DEED}`;
const ENDPOINT = `http://127.0.0.1:${PORT}`;
const KEY_A = path.join(credentialsDir(), "testnet", "workers", `${VAULT}.worker-a.json`);
const CALLS_EACH = 8;
const T = (n) => (BigInt(Math.round(n * 1e6))).toString(); // tUSDC, 6 decimals

const run = createRun("wash-reject", SLUG);
const { say, banner, step, agent, start, record } = run;
Object.assign(record, { kind: "wash-reject", vault: VAULT, deed: DEED, seller: SELLER, buyer: BUYER });

async function main() {
  banner(`Wash-revenue rejection on testnet: deed ${DEED}, new business ${SLUG}, seller ${SELLER}`);
  portsFree([PORT, ECHO_PORT]);
  buildPackages();
  const sdk = await import("../sdk/dist/src/index.js");
  const rpc = new sdk.Rpc(process.env.NEAR_RPC_URLS ? process.env.NEAR_RPC_URLS.split(",") : sdk.TESTNET_RPC_URLS);
  const seller = account(SELLER);

  banner("1. the seller mints the deed and registers worker A");
  const mint = await agent("agents/dist/src/owner.js", ["mint", "--as", SELLER, "--slug", SLUG, "--title", "Webhook Relay (wash test)", "--price", "0.01", "--endpoint", ENDPOINT, "--image-hash", "sha256:wash-test", "--daily-cap", "50"], "01-mint", 0);
  step(`seller mints ${SLUG}`, { tx: mint.tx, success: mint.success });
  if (!mint.success) throw new Error("mint failed");
  const rot = await agent("agents/dist/src/owner.js", ["rotate", "--as", SELLER, "--vault", VAULT, "--endpoint", ENDPOINT, "--key-file", KEY_A], "02-worker-a");
  step("seller sets worker key A and endpoint", { tx: rot.tx, success: rot.success });
  start("echo", "agents/dist/src/echo-target.js", ["--port", String(ECHO_PORT), "--fail-rate", "0"]);
  start("worker-a", "worker/dist/src/cli.js", ["--vault", VAULT, "--network", "testnet", "--port", String(PORT), "--key-file", KEY_A, "--allow-target", `127.0.0.1:${ECHO_PORT}`, "--flush-ms", "8000", "--watch-ms", "30000", "--wait-for-key", "120", "--data-dir", path.join(run.logs, "worker-a-data")]);
  await waitHealth(ENDPOINT, 180_000);
  say("worker A is serving");

  banner("2. the seller creates and funds two fresh customer accounts");
  const names = [`${SLUG}-c1.testnet`, `${SLUG}-c2.testnet`];
  const keys = {};
  for (const [i, name] of names.entries()) {
    const kp = newKeyPair();
    const out = await retrySend(() => call(seller, "testnet", "create_account", { new_account_id: name, new_public_key: kp.getPublicKey().toString() }, { gas: 50n * TGAS, deposit: i === 0 ? NEAR / 4n : NEAR / 20n }), say);
    step(`seller creates customer account ${name}`, { tx: out.hash, success: out.success });
    if (!out.success) throw new Error(`could not create ${name}`);
    saveKeyPair(name, kp);
    keys[name] = kp.toString();
  }
  const [c1, c2] = names;
  // The seller's own tUSDC (anyone may mint up to 1,000 per call on this test token).
  const reg = await view(TUSDC, "storage_balance_of", { account_id: SELLER });
  if (!reg) await retrySend(() => call(seller, TUSDC, "storage_deposit", { account_id: SELLER, registration_only: true }, { gas: 30n * TGAS, deposit: 1_250_000_000_000_000_000_000n }), say);
  const minted = await retrySend(() => call(seller, TUSDC, "mint", { amount: T(10) }, { gas: 30n * TGAS }), say);
  step("seller mints 10 tUSDC for itself", { tx: minted.hash, success: minted.success });
  await retrySend(() => call(seller, TUSDC, "storage_deposit", { account_id: c1, registration_only: true }, { gas: 30n * TGAS, deposit: 1_250_000_000_000_000_000_000n }), say);
  const give = await retrySend(() => call(seller, TUSDC, "ft_transfer", { receiver_id: c1, amount: T(3) }, { gas: 30n * TGAS, deposit: ONE_YOCTO }), say);
  step(`seller sends 3 tUSDC to ${c1} (ft_transfer)`, { tx: give.hash, success: give.success });
  const dep1 = await retrySend(() => call(account(c1, keys[c1]), TUSDC, "ft_transfer_call", { receiver_id: VAULT, amount: T(2), msg: "" }, { gas: 60n * TGAS, deposit: ONE_YOCTO }), say);
  step(`${c1} deposits the seller's tUSDC as its own credit (sender == customer)`, { tx: dep1.hash, success: dep1.success });
  const dep2 = await retrySend(() => call(seller, TUSDC, "ft_transfer_call", { receiver_id: VAULT, amount: T(2), msg: JSON.stringify({ deposit_for: c2 }) }, { gas: 60n * TGAS, deposit: ONE_YOCTO }), say);
  step(`seller deposits credit for ${c2} (deposit_for, sender != customer)`, { tx: dep2.hash, success: dep2.success });

  banner(`3. both customers send ${CALLS_EACH} paid deliveries; worker A charges them`);
  for (const name of names) {
    const client = new sdk.DeedClient({ vault: VAULT, accountId: name, signer: sdk.signerFromSecretKey(keys[name]), rpc });
    for (let n = 1; n <= CALLS_EACH; n++) {
      await client.deliver({ url: `http://127.0.0.1:${ECHO_PORT}/hook?from=${name}&n=${n}`, method: "POST", headers: {}, body: JSON.stringify({ n }), idempotency_key: `${SLUG}-${name}-${n}` });
    }
    say(`${name}: ${CALLS_EACH} deliveries accepted with signed receipts`);
  }
  const vaultViews = new sdk.VaultViews(rpc, VAULT);
  const want = 2 * CALLS_EACH;
  const end = Date.now() + 240_000;
  let info = await vaultViews.info();
  while (Number(info.charged_items) < want && Date.now() < end) {
    await sleep(10_000);
    info = await vaultViews.info();
    say(`charges landing: ${info.charged_items} of ${want}, vault revenue ${sdk.formatUnits(info.revenue, 6)} tUSDC`);
  }
  const charges = [...run.logText("worker-a").matchAll(/charge tx (\w+): (\d+) of (\d+) items charged/g)].map((m) => m[1]);
  step(`worker A charged all ${want} deliveries`, { tx: charges[0] ?? null, success: Number(info.charged_items) >= want, note: `${info.charged_items} charges, revenue ${sdk.formatUnits(info.revenue, 6)} tUSDC` });
  record.charge_txs = charges;

  banner("4. the seller lists the deed");
  const list = await agent("agents/dist/src/owner.js", ["list", "--as", SELLER, "--token-id", SLUG, "--price", "1"], "04-list");
  step(`seller lists ${SLUG} for 1 tUSDC`, { tx: list.tx, success: list.success && list.listing?.active === true });
  say("waiting 30 s so the transaction index has the newest charges");
  await sleep(30_000);

  banner("5. the buyer agent appraises the listing with the relaxed demo policy");
  const buy = await agent("agents/dist/src/buyer.js", ["--account", BUYER, "--token-id", SLUG, "--policy", "demo", "--max-payback-days", "365", "--dry-run"], "05-buyer");
  const ev = buy.evaluated?.[0];
  const skip = buy.decision === "skip" && ev?.decision === "skip";
  const reason = /revenue from owner-funded customers excluded/.test(ev?.why ?? "");
  step("buyer agent decides SKIP", { success: skip, note: ev?.why });
  step('the reason says "revenue from owner-funded customers excluded"', { success: reason });
  const customers = ev?.customers ?? [];
  step("both wash customers are classified owner-funded", { success: customers.length === 2 && customers.every((c) => c.class === "owner-funded"), note: customers.map((c) => `${c.customer}: ${c.reason}`).join("; ") });
  record.buyer = { decision: buy.decision, policy: buy.policy, why: ev?.why ?? null, customers, independent_revenue_30d: ev?.independent_revenue_30d ?? null, excluded: ev?.excluded ?? null, checks: ev?.checks ?? [] };

  banner("6. the seller cancels the listing (the wash deed should not show as for sale)");
  const cancel = await agent("agents/dist/src/owner.js", ["cancel", "--as", SELLER, "--token-id", SLUG], "06-cancel");
  step(`seller cancels the listing of ${SLUG}`, { tx: cancel.tx, success: cancel.success });
  record.links = { vault: addressLink(VAULT), customers: names.map(addressLink) };
}

let failed = null;
try {
  await main();
} catch (e) {
  failed = e instanceof Error ? e.message : String(e);
  say(`wash-reject failed: ${failed}`);
} finally {
  await run.stopAll();
  record.finished_at = new Date().toISOString();
  record.ok = failed === null && record.steps.length > 0 && record.steps.every((s) => s.ok);
  if (failed) record.error = failed;
  record.logs = `demo-logs/${run.id}/ (local only)`;
  const d = loadDeployments();
  d.washReject_runs = [...(d.washReject_runs || []), { run: run.id, ok: record.ok, finished_at: record.finished_at, ...(failed ? { error: failed } : {}) }];
  if (record.ok || !d.washReject) d.washReject = record;
  saveDeployments(d);
  say(`all local processes stopped. Wash rejection ${record.ok ? "shown" : "FAILED"}; recorded in deployments/testnet.json${record.ok ? ' under "washReject"' : ""}`);
  run.close();
  process.exitCode = record.ok ? 0 : 1;
}
