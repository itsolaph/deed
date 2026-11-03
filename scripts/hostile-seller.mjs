#!/usr/bin/env node
// Hostile seller on testnet: the seller sells the deed and then kills its worker with SIGKILL
// before any hand-off, while customers have jobs in flight (some charged on chain, some not).
// What must hold, and is checked here:
//   - the buyer's worker B serves new calls once the endpoint on chain rotates;
//   - a customer whose process restarted resubmits its saved receipts (DeedClient + fileStore)
//     to the endpoint on chain; B delivers the ones A charged without charging again and charges
//     the ones A never charged exactly once;
//   - a customer that asks for its money back instead gets its unspent credit (including the
//     price of every job A accepted but never charged) after the refund delay;
//   - double charges: 0 (chain seq and balances against the receipts the customers hold).
//
// Steps: mint + worker A, customers deposit and send jobs, list, buy, outage at the target so
// jobs stay undelivered, A charges some, customers send more, SIGKILL A, buyer starts B and
// rotates key + endpoint, alice resubmits from her saved receipts and sends new calls, bob
// requests a refund, resubmits, waits out the refund delay and claims.
//
// Environment: HOSTILE_SELLER (a fresh faucet account, about 3.5 NEAR; default DEMO_SELLER),
// DEMO_BUYER, DEMO_ALICE, DEMO_BOB, HOSTILE_SLUG (default hostile-<MMDDHHMM>), HOSTILE_PORT_A
// (7606), HOSTILE_PORT_B (7607), HOSTILE_ECHO_PORT (7614), NEAR_RPC_URLS. Takes about 20 minutes
// (10 of them are the vault's refund delay). Recorded in deployments/testnet.json under
// "hostileSeller". Keys stay in the legacy keychain and are never printed.

import "./lib/env.mjs";
import fs from "node:fs";
import path from "node:path";
import { loadDeployments, saveDeployments } from "./lib/deployments.mjs";
import { ONE_YOCTO, TGAS, account, addressLink, call, credentialsDir, txLink } from "./lib/near.mjs";
import { buildPackages, createRun, portsFree, retrySend, sleep, stamp, waitHealth } from "./lib/run.mjs";

const PORT_A = Number(process.env.HOSTILE_PORT_A || 7606);
const PORT_B = Number(process.env.HOSTILE_PORT_B || 7607);
const ECHO_PORT = Number(process.env.HOSTILE_ECHO_PORT || 7614);
const SLUG = process.env.HOSTILE_SLUG || `hostile-${stamp()}`;
const dep = loadDeployments();
const SELLER = process.env.HOSTILE_SELLER || process.env.DEMO_SELLER || dep.accounts.seller;
const BUYER = process.env.DEMO_BUYER || dep.accounts.buyer;
const ALICE = process.env.DEMO_ALICE || dep.accounts.alice;
const BOB = process.env.DEMO_BOB || dep.accounts.bob;
const DEED = dep.accounts.deed;
const TUSDC = dep.accounts.tusdc;
const VAULT = `${SLUG}.${DEED}`;
const ENDPOINT_A = `http://127.0.0.1:${PORT_A}`;
const ENDPOINT_B = `http://127.0.0.1:${PORT_B}`;
const WORKERS = path.join(credentialsDir(), "testnet", "workers");
const KEY_A = path.join(WORKERS, `${VAULT}.worker-a.json`);
const KEY_B = path.join(WORKERS, `${VAULT}.worker-b.json`);
const PHASE1 = 3; // charged and delivered before the sale
const PHASE2 = 3; // charged by A, not delivered (target down)
const PHASE3 = 2; // accepted by A, neither charged nor delivered at the kill
const AFTER = 2; // new calls of alice served by B
const PRICE = 10_000n; // 0.01 tUSDC
const TOP_UP = 1_500_000n; // 1.5 tUSDC

const run = createRun("hostile-seller", SLUG);
const { say, banner, step, agent, start, stop, record } = run;
const OUTAGE = path.join(run.logs, "target-outage");
Object.assign(record, { kind: "hostile-seller", vault: VAULT, deed: DEED, accounts: { seller: SELLER, buyer: BUYER, customers: [ALICE, BOB] } });

async function main() {
  banner(`Hostile seller on testnet: deed ${DEED}, new business ${SLUG}, seller ${SELLER}`);
  portsFree([PORT_A, PORT_B, ECHO_PORT]);
  buildPackages();
  const sdk = await import("../sdk/dist/src/index.js");
  const sdkNode = await import("../sdk/dist/src/node.js");
  const common = await import("../agents/dist/src/common.js");
  const urls = process.env.NEAR_RPC_URLS ? process.env.NEAR_RPC_URLS.split(",") : sdk.TESTNET_RPC_URLS;
  const rpc = new sdk.Rpc(urls);
  const vault = new sdk.VaultViews(rpc, VAULT);
  const short = (a) => a.replace(/\.testnet$/, "");

  // ---------------------------------------------------------------- 1. the business
  banner("1. the seller mints the deed and runs worker A");
  const mint = await agent("agents/dist/src/owner.js", ["mint", "--as", SELLER, "--slug", SLUG, "--title", "Webhook Relay (hostile seller test)", "--price", "0.01", "--endpoint", ENDPOINT_A, "--image-hash", "sha256:hostile-test", "--daily-cap", "50"], "01-mint", 0);
  step(`seller mints ${SLUG}`, { tx: mint.tx, success: mint.success });
  if (!mint.success) throw new Error("mint failed");
  const rotA = await agent("agents/dist/src/owner.js", ["rotate", "--as", SELLER, "--vault", VAULT, "--endpoint", ENDPOINT_A, "--key-file", KEY_A], "02-worker-a");
  step("seller sets worker key A and endpoint", { tx: rotA.tx, success: rotA.success });
  record.worker_a_key = rotA.public_key;
  start("echo", "agents/dist/src/echo-target.js", ["--port", String(ECHO_PORT), "--fail-rate", "0", "--outage-file", OUTAGE]);
  // A long flush interval: A charges when told by the clock, so jobs accepted right before the
  // kill are certainly not charged yet.
  start("worker-a", "worker/dist/src/cli.js", ["--vault", VAULT, "--network", "testnet", "--port", String(PORT_A), "--key-file", KEY_A, "--allow-target", `127.0.0.1:${ECHO_PORT}`, "--flush-ms", "30000", "--watch-ms", "30000", "--wait-for-key", "120", "--data-dir", path.join(run.logs, "worker-a-data")]);
  await waitHealth(ENDPOINT_A, 180_000);
  say("worker A is serving");

  // ---------------------------------------------------------------- 2. customers
  banner("2. alice and bob deposit credit and send jobs; worker A delivers and charges them");
  const customers = {};
  for (const acc of [ALICE, BOB]) {
    const key = sdkNode.readKeyFile(sdkNode.keychainFile(acc)).private_key;
    const signer = new sdkNode.NodeSigner(acc, key, urls);
    await common.ensureTusdc(rpc, TUSDC, acc, TOP_UP);
    const store = path.join(run.logs, `receipts-${short(acc)}.json`);
    const make = () => new sdk.DeedClient({ vault: VAULT, accountId: acc, signer: sdk.signerFromSecretKey(key), rpc, transactor: sdkNode.createNodeTransactor(signer), store: sdkNode.fileStore(store), keyCacheMs: 0 });
    const client = make();
    const top = await retrySend(() => client.topUp(TOP_UP), say);
    step(`${short(acc)} deposits 1.5 tUSDC (ft_transfer_call)`, { tx: top.hash, success: top.success });
    customers[acc] = { make, client, store, sent: 0, ids: {}, seq0: null };
  }
  for (const acc of [ALICE, BOB]) customers[acc].seq0 = Number((await vault.customer(acc)).last_seq);
  const send = async (acc, phase, n) => {
    const c = customers[acc];
    for (let i = 0; i < n; i++) {
      const k = ++c.sent;
      const res = await c.client.deliver({ url: `http://127.0.0.1:${ECHO_PORT}/hook?from=${short(acc)}&n=${k}`, method: "POST", headers: {}, body: JSON.stringify({ k, phase }), idempotency_key: `${SLUG}-${short(acc)}-${k}` });
      c.ids[res.delivery_id] = { phase, seq: res.receipt.payload.seq, key: res.receipt.payload.worker_public_key };
    }
  };
  const lastSeq = async (acc) => Number((await vault.customer(acc))?.last_seq ?? -1);
  const waitSeq = async (acc, target, ms) => {
    const end = Date.now() + ms;
    for (;;) {
      const s = await lastSeq(acc);
      if (s >= target || Date.now() > end) return s;
      await sleep(5000);
    }
  };
  for (const acc of [ALICE, BOB]) await send(acc, 1, PHASE1);
  for (const acc of [ALICE, BOB]) {
    const end = Date.now() + 120_000;
    while (customers[acc].client.pendingCount() > 0 && Date.now() < end) {
      await customers[acc].client.track().catch(() => undefined);
      await sleep(3000);
    }
  }
  for (const acc of [ALICE, BOB]) await waitSeq(acc, customers[acc].seq0 + PHASE1, 120_000);
  step("phase 1: jobs delivered and charged by worker A", { success: (await lastSeq(ALICE)) === customers[ALICE].seq0 + PHASE1 && (await lastSeq(BOB)) === customers[BOB].seq0 + PHASE1 });

  // ---------------------------------------------------------------- 3. the sale
  banner("3. the seller lists, the buyer buys");
  const list = await agent("agents/dist/src/owner.js", ["list", "--as", SELLER, "--token-id", SLUG, "--price", "2"], "03-list");
  step(`seller lists ${SLUG} for 2 tUSDC`, { tx: list.tx, success: list.success && list.listing?.active === true });
  await common.ensureTusdc(rpc, TUSDC, BUYER, 2_000_000n);
  const listing = list.listing;
  const buy = await retrySend(() => call(account(BUYER), TUSDC, "ft_transfer_call", { receiver_id: DEED, amount: "2000000", msg: JSON.stringify({ buy: { token_id: SLUG, max_price: "2000000", listing_id: listing.listing_id } }) }, { gas: 250n * TGAS, deposit: ONE_YOCTO }), say);
  const infoAfterBuy = await vault.info();
  step(`buyer ${BUYER} buys ${SLUG}`, { tx: buy.hash, success: buy.success && infoAfterBuy.owner_id === BUYER });

  // ---------------------------------------------------------------- 4. jobs in flight, then SIGKILL
  banner("4. the target goes down; jobs pile up; A charges some; the seller kills A with SIGKILL");
  fs.writeFileSync(OUTAGE, "");
  for (const acc of [ALICE, BOB]) await send(acc, 2, PHASE2);
  for (const acc of [ALICE, BOB]) await waitSeq(acc, customers[acc].seq0 + PHASE1 + PHASE2, 180_000);
  const chargedA = [...run.logText("worker-a").matchAll(/charge tx (\w+): (\d+) of (\d+) items charged/g)].map((m) => ({ tx: m[1], charged: Number(m[2]) }));
  record.worker_a_charge_txs = chargedA.map((c) => c.tx);
  step("worker A charged the phase-2 jobs it could not deliver yet", { tx: chargedA.at(-1)?.tx ?? null, success: (await lastSeq(ALICE)) === customers[ALICE].seq0 + PHASE1 + PHASE2 && (await lastSeq(BOB)) === customers[BOB].seq0 + PHASE1 + PHASE2 });
  for (const acc of [ALICE, BOB]) await send(acc, 3, PHASE3);
  stop("worker-a", "SIGKILL");
  await run.waitExit("worker-a", 10_000);
  const killedAt = new Date().toISOString();
  await sleep(8000);
  const inflight = {};
  for (const acc of [ALICE, BOB]) {
    const chainSeq = await lastSeq(acc);
    const open = customers[acc].client.pendingEntries();
    inflight[acc] = { open: open.length, charged: open.filter((e) => e.receipt.payload.seq <= chainSeq).length, uncharged: open.filter((e) => e.receipt.payload.seq > chainSeq).length, chain_seq: chainSeq };
  }
  const total = (k) => inflight[ALICE][k] + inflight[BOB][k];
  say(`jobs in flight at the kill (${killedAt}): ${total("open")} (charged on chain, not delivered: ${total("charged")}; accepted, not charged: ${total("uncharged")})`);
  step("worker A killed with SIGKILL while jobs were in flight (no flush, no hand-off)", { success: total("charged") === 2 * PHASE2 && total("uncharged") === 2 * PHASE3, note: JSON.stringify(inflight) });
  record.in_flight_at_kill = { at: killedAt, total: total("open"), charged_not_delivered: total("charged"), accepted_not_charged: total("uncharged"), per_customer: inflight };
  // The customers' processes "restart": the in-memory clients are dropped, the receipt files stay.
  for (const acc of [ALICE, BOB]) customers[acc].client = null;

  // ---------------------------------------------------------------- 5. buyer takes over
  banner("5. the buyer starts worker B and rotates key and endpoint in one transaction");
  const kg = await agent("agents/dist/src/owner.js", ["keygen", "--as", BUYER, "--vault", VAULT, "--key-file", KEY_B], "05-keygen", 0);
  record.worker_b_key = kg.public_key;
  start("worker-b", "worker/dist/src/cli.js", ["--vault", VAULT, "--network", "testnet", "--port", String(PORT_B), "--key-file", KEY_B, "--allow-target", `127.0.0.1:${ECHO_PORT}`, "--flush-ms", "8000", "--watch-ms", "30000", "--wait-for-key", "240", "--data-dir", path.join(run.logs, "worker-b-data")]);
  const rotB = await agent("agents/dist/src/owner.js", ["rotate", "--as", BUYER, "--vault", VAULT, "--endpoint", ENDPOINT_B, "--key-file", KEY_B], "05-rotate");
  step("buyer rotates worker key and endpoint (A's key is deleted)", { tx: rotB.tx, success: rotB.success });
  await waitHealth(ENDPOINT_B, 240_000);
  say("worker B is serving at the endpoint now on chain");
  fs.rmSync(OUTAGE, { force: true });
  say("the target is back up");

  // ---------------------------------------------------------------- 6. alice resubmits
  banner("6. alice restarts, loads her saved receipts and resubmits them to the endpoint on chain");
  const alice = customers[ALICE];
  alice.client = alice.make();
  say(`alice's restarted client loaded ${alice.client.pendingCount()} open receipts from its file`);
  const resA = await alice.client.resubmit();
  const takenFree = resA.filter((r) => r.result === "accepted" && r.charged_as_new === false).length;
  const chargedNew = resA.filter((r) => r.result === "accepted" && r.charged_as_new === true).length;
  step("worker B takes over alice's receipts (receipts signed by worker A's old key)", { success: takenFree === PHASE2 && chargedNew === PHASE3, note: `${takenFree} already charged by A: delivered without a new charge; ${chargedNew} never charged: charged once by B` });
  await send(ALICE, 4, AFTER);
  const newByB = Object.values(alice.ids).filter((x) => x.phase === 4 && x.key === kg.public_key).length;
  step("worker B serves alice's new calls (receipts signed by key B)", { success: newByB === AFTER, note: `${newByB} of ${AFTER}` });

  // ---------------------------------------------------------------- 7. bob refunds
  banner("7. bob asks for his money back instead, then resubmits");
  const bob = customers[BOB];
  bob.client = bob.make();
  const bobBefore = await vault.customer(BOB);
  const reqRefund = await retrySend(() => bob.client.requestRefund(), say);
  step("bob requests a refund of his unspent credit", { tx: reqRefund.hash, success: reqRefund.success });
  const resB = await bob.client.resubmit();
  const bobFree = resB.filter((r) => r.result === "accepted" && r.charged_as_new === false).length;
  const bobRefused = resB.filter((r) => r.result === "rejected" && /refund_pending/.test(r.reason ?? "")).length;
  step("worker B delivers bob's jobs A charged, and refuses to charge the others while the refund is pending", { success: bobFree === PHASE2 && bobRefused === PHASE3, note: `${bobFree} delivered without a new charge, ${bobRefused} refused (refund pending)` });

  // ---------------------------------------------------------------- 8. delivery
  banner("8. every taken-over job is delivered by worker B");
  const delivered = { [ALICE]: new Set(), [BOB]: new Set() };
  const end = Date.now() + 240_000;
  while (Date.now() < end && (alice.client.pendingCount() > 0 || bob.client.pendingCount() > 0)) {
    for (const acc of [ALICE, BOB]) {
      const r = await customers[acc].client.track().catch((e) => (say(`${short(acc)} track: ${e.message}`), { delivered: [] }));
      for (const id of r.delivered) delivered[acc].add(id);
    }
    await sleep(4000);
  }
  const deliveredByB = delivered[ALICE].size + delivered[BOB].size;
  step("jobs delivered by worker B after the kill", { success: alice.client.pendingCount() === 0 && bob.client.pendingCount() === 0, note: `${deliveredByB} delivered (alice ${delivered[ALICE].size}, bob ${delivered[BOB].size})` });
  await sleep(20_000); // B's last charge batch

  // ---------------------------------------------------------------- 9. refund
  const info = await vault.info();
  const readyAt = Number((await vault.customer(BOB))?.refund_available_at_ms ?? 0);
  const waitMs = Math.max(0, readyAt - Date.now()) + 15_000;
  banner(`9. bob waits out the refund delay (${info.refund_delay_sec} s; ${Math.round(waitMs / 1000)} s left) and claims`);
  await sleep(waitMs);
  const bobAtClaim = await vault.customer(BOB);
  const claim = await retrySend(() => bob.client.claimRefund(), say);
  const refunded = BigInt(bobAtClaim?.balance ?? "0");
  step("bob claims his refund (unspent credit, including every job A never charged)", { tx: claim.hash, success: claim.success, note: `${sdk.formatUnits(refunded, 6)} tUSDC back` });

  // ---------------------------------------------------------------- 10. the ledger check
  banner("10. double-charge check: chain seq and balances against the receipts the customers hold");
  const aliceSeq = await lastSeq(ALICE);
  const expectedAlice = PHASE1 + PHASE2 + PHASE3 + AFTER; // every alice job charged exactly once
  const expectedBob = PHASE1 + PHASE2; // bob's phase-3 jobs were never charged
  const chargesAlice = aliceSeq - alice.seq0;
  const chargesBob = Number(bobBefore.last_seq) - bob.seq0;
  const aliceView = await vault.customer(ALICE);
  const aliceSpent = TOP_UP - BigInt(aliceView.balance);
  const bobSpent = TOP_UP - refunded;
  const doubleCharges = Math.max(0, chargesAlice - expectedAlice) + Math.max(0, chargesBob - expectedBob);
  const moneyOk = aliceSpent === BigInt(expectedAlice) * PRICE && bobSpent === BigInt(expectedBob) * PRICE;
  say(`alice: ${chargesAlice} charges on chain for ${expectedAlice} distinct jobs, spent ${sdk.formatUnits(aliceSpent, 6)} tUSDC`);
  say(`bob: ${chargesBob} charges on chain for ${expectedBob} distinct jobs, spent ${sdk.formatUnits(bobSpent, 6)} tUSDC, refunded ${sdk.formatUnits(refunded, 6)} tUSDC`);
  step("double charges: 0", { success: doubleCharges === 0 && chargesAlice === expectedAlice && chargesBob === expectedBob && moneyOk, note: `${doubleCharges} double charges; spend matches price x distinct jobs: ${moneyOk}` });
  const chargesB = [...run.logText("worker-b").matchAll(/charge tx (\w+): (\d+) of (\d+) items charged/g)].map((m) => m[1]);
  record.worker_b_charge_txs = chargesB;
  if (chargesB[0]) step("worker B charges with the new key", { tx: chargesB[0], success: true });

  record.summary = {
    in_flight_at_kill: total("open"),
    charged_not_delivered_at_kill: total("charged"),
    accepted_not_charged_at_kill: total("uncharged"),
    delivered_by_b: deliveredByB,
    new_calls_served_by_b: newByB,
    refunded_jobs: bobRefused,
    refunded_tusdc: sdk.formatUnits(refunded, 6),
    double_charges: doubleCharges,
  };
  say(`summary: ${JSON.stringify(record.summary)}`);
  record.links = { vault: addressLink(VAULT), refund_claim: txLink(claim.hash) };
}

let failed = null;
try {
  await main();
} catch (e) {
  failed = e instanceof Error ? e.message : String(e);
  say(`hostile-seller failed: ${failed}`);
} finally {
  await run.stopAll();
  record.finished_at = new Date().toISOString();
  record.ok = failed === null && record.steps.length > 0 && record.steps.every((s) => s.ok);
  if (failed) record.error = failed;
  record.logs = `demo-logs/${run.id}/ (local only)`;
  const d = loadDeployments();
  d.hostileSeller_runs = [...(d.hostileSeller_runs || []), { run: run.id, ok: record.ok, finished_at: record.finished_at, ...(failed ? { error: failed } : {}) }];
  if (record.ok || !d.hostileSeller) d.hostileSeller = record;
  saveDeployments(d);
  say(`all local processes stopped. Hostile seller run ${record.ok ? "passed" : "FAILED"}; recorded in deployments/testnet.json${record.ok ? ' under "hostileSeller"' : ""}`);
  run.close();
  process.exitCode = record.ok ? 0 : 1;
}
