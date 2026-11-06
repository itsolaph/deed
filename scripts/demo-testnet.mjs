#!/usr/bin/env node
// The whole Outlive story on testnet, with an explorer link at every step:
//
//   echo target and worker A (seller) up, traffic running, revenue ticking, seller lists,
//   the buyer agent decides and buys, the seller's withdraw reverts, the buyer starts worker B
//   and rotates key and endpoint in one transaction, worker A stops by itself, traffic
//   continues through worker B, pending obligations are delivered, the buyer withdraws.
//
// Every local process binds 127.0.0.1 on ports 7601, 7602 and 7611 and is stopped at the end.
// Logs go to demo-logs/<run>/ (not committed). Links are saved to deployments/testnet.json
// under "demo".
//
// Environment: DEMO_SLUG (default relay-<MMDDHHMM>), DEMO_TRAFFIC_SEC (default 75),
// DEMO_AFTER_SEC (default 45), DEMO_SELLER, DEMO_BUYER, DEMO_ALICE, DEMO_BOB,
// NEAR_CREDENTIALS_DIR.

import "./lib/env.mjs";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadDeployments, saveDeployments, ROOT } from "./lib/deployments.mjs";
import { addressLink, txLink, view } from "./lib/near.mjs";

// Ports bind 127.0.0.1 and can be overridden with DEMO_ECHO_PORT, DEMO_PORT_A
// and DEMO_PORT_B when the defaults are taken by long-running services.
const ECHO_PORT = Number(process.env.DEMO_ECHO_PORT || 7611);
const PORT_A = Number(process.env.DEMO_PORT_A || 7601);
const PORT_B = Number(process.env.DEMO_PORT_B || 7602);
const PRICE_PER_CALL = "0.01"; // tUSDC
const LIST_PRICE = "3"; // tUSDC
const TRAFFIC_SEC = Number(process.env.DEMO_TRAFFIC_SEC || 75);
const AFTER_SEC = Number(process.env.DEMO_AFTER_SEC || 45);
const DECIMALS = 6;

const stamp = new Date().toISOString().slice(5, 16).replace(/\D/g, ""); // MMDDHHMM
const SLUG = process.env.DEMO_SLUG || `relay-${stamp}`;
const RUN = `${new Date().toISOString().replace(/[:.]/g, "-")}-${SLUG}`;
const LOGS = path.join(ROOT, "demo-logs", RUN);
fs.mkdirSync(LOGS, { recursive: true });

const dep = loadDeployments();
// Accounts come from deployments/testnet.json; set DEMO_SELLER, DEMO_BUYER, DEMO_ALICE and
// DEMO_BOB to run the story with your own testnet accounts (keys in the legacy keychain).
const A = {
  ...dep.accounts,
  seller: process.env.DEMO_SELLER || dep.accounts.seller,
  buyer: process.env.DEMO_BUYER || dep.accounts.buyer,
  alice: process.env.DEMO_ALICE || dep.accounts.alice,
  bob: process.env.DEMO_BOB || dep.accounts.bob,
};
const OUTLIVE = A.outlive;
const VAULT = `${SLUG}.${OUTLIVE}`;
const KEYS_DIR = path.join(process.env.NEAR_CREDENTIALS_DIR || path.join(process.env.HOME || "", ".near-credentials"), "testnet", "workers");
const KEY_A = path.join(KEYS_DIR, `${VAULT}.worker-a.json`);
const KEY_B = path.join(KEYS_DIR, `${VAULT}.worker-b.json`);
const OUTAGE_FILE = path.join(LOGS, "target-outage");
const ENDPOINT_A = `http://127.0.0.1:${PORT_A}`;
const ENDPOINT_B = `http://127.0.0.1:${PORT_B}`;

const record = {
  run: RUN,
  slug: SLUG,
  vault: VAULT,
  outlive: OUTLIVE,
  accounts: { seller: A.seller, buyer: A.buyer, customers: [A.alice, A.bob] },
  started_at: new Date().toISOString(),
  steps: [],
  links: {},
};
const children = new Map();
const demoLog = fs.createWriteStream(path.join(LOGS, "demo.log"));

function say(line) {
  const text = `${new Date().toISOString().slice(11, 19)} [demo] ${line}`;
  console.log(text);
  demoLog.write(text + "\n");
}

function banner(title) {
  say("");
  say(`=== ${title}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Records a step. `expect` is "success" or "failure"; ok means the outcome was the expected one. */
function step(name, { tx = null, success = null, expect = "success", note = undefined } = {}) {
  const ok = success === null ? true : expect === "success" ? success : !success;
  const entry = { step: name, expect, ok, ...(tx ? { tx, link: txLink(tx) } : {}), ...(note ? { note } : {}) };
  record.steps.push(entry);
  say(`${ok ? "ok  " : "FAIL"} ${name}${tx ? `  ${txLink(tx)}` : ""}${note ? `  (${note})` : ""}`);
  return entry;
}

function node(script, args) {
  return spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: "utf8", env: process.env, maxBuffer: 16 * 1024 * 1024 });
}

/** Runs an agent to completion, mirrors its output, returns its --out JSON. */
/** Every on-chain step goes through here: a short settle before each keeps the
 *  public RPC quota window from bursting when steps queue up back to back. */
async function run(script, args, name) {
  await sleep(8000);
  const out = path.join(LOGS, `${name}.json`);
  const res = node(script, [...args, "--out", out]);
  fs.writeFileSync(path.join(LOGS, `${name}.log`), (res.stdout || "") + (res.stderr || ""));
  for (const line of (res.stdout || "").trimEnd().split("\n")) if (line) console.log("  " + line);
  if (res.stderr?.trim()) console.log("  " + res.stderr.trim().split("\n").join("\n  "));
  return fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { success: false, error: res.stderr };
}

/** Starts a long-running process with its output in demo-logs. */
function start(name, script, args) {
  const logFile = path.join(LOGS, `${name}.log`);
  const fd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: ["ignore", fd, fd], env: process.env });
  fs.writeFileSync(path.join(LOGS, `${name}.pid`), String(child.pid));
  children.set(name, child);
  child.on("exit", (code) => say(`${name} exited (code ${code})`));
  say(`started ${name} (pid ${child.pid}), log demo-logs/${RUN}/${name}.log`);
  return child;
}

function stop(name, signal = "SIGTERM") {
  const child = children.get(name);
  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal);
}

function waitExit(name, ms) {
  const child = children.get(name);
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    child.on("exit", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
}

async function waitHealth(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${url}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return res.json();
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error(`${url} did not come up`);
}

function logText(name) {
  const f = path.join(LOGS, `${name}.log`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
}

function chargeTxs(name) {
  return [...logText(name).matchAll(/charge tx (\w+): (\d+) of (\d+) items charged/g)].map((m) => ({ tx: m[1], charged: Number(m[2]), items: Number(m[3]) }));
}

/** Access keys of an account, read with the SDK's RPC client (built at the start of the run). */
async function accessKeys(accountId) {
  try {
    const { Rpc } = await import("../sdk/dist/src/index.js");
    return { keys: await new Rpc().accessKeys(accountId) };
  } catch {
    return null;
  }
}

const fmt = (units) => (Number(BigInt(units)) / 10 ** DECIMALS).toFixed(4);

/** sha256 over the compiled worker code: the image hash the owner publishes (a claim). */
function workerImageHash() {
  const dir = path.join(ROOT, "worker", "dist", "src");
  const h = crypto.createHash("sha256");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) h.update(f).update(fs.readFileSync(path.join(dir, f)));
  return `sha256:${h.digest("hex")}`;
}

function portsFree() {
  for (const p of [PORT_A, PORT_B, ECHO_PORT]) {
    const res = spawnSync("fuser", [`${p}/tcp`], { encoding: "utf8" });
    if (res.status === 0 && res.stdout.trim()) throw new Error(`port ${p} is in use; stop that process first (fuser -k ${p}/tcp)`);
  }
}

async function main() {
  banner(`Outlive demo on testnet: outlive ${OUTLIVE}, new business ${SLUG}`);
  portsFree();
  say("building TypeScript packages");
  const build = spawnSync("npx", ["tsc", "-b", "sdk", "worker", "agents"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}${build.stderr}`);
  const imageHash = workerImageHash();
  record.image_hash = imageHash;

  // 1. The seller mints the business: a token NFT plus its vault sub-account.
  banner("1. seller mints the token; the Outlive contract creates the vault sub-account");
  const mint = await run("agents/dist/src/owner.js", ["mint", "--as", A.seller, "--slug", SLUG, "--title", "Webhook Relay", "--price", PRICE_PER_CALL, "--endpoint", ENDPOINT_A, "--image-hash", imageHash, "--daily-cap", "50"], "01-mint");
  step(`seller mints ${SLUG}`, { tx: mint.tx, success: mint.success });
  if (!mint.success) throw new Error("mint failed");
  record.links.vault = addressLink(VAULT);
  const keys = await accessKeys(VAULT);
  say(`vault ${VAULT} access keys after mint: ${keys ? keys.keys.length : "?"} (no full-access key)`);

  // 2. Worker A key, registered with the endpoint in one transaction.
  banner("2. seller registers worker A (function-call key limited to charge)");
  const rotA = await run("agents/dist/src/owner.js", ["rotate", "--as", A.seller, "--vault", VAULT, "--endpoint", ENDPOINT_A, "--key-file", KEY_A], "02-worker-a");
  step("seller sets worker key A and endpoint", { tx: rotA.tx, success: rotA.success });
  record.worker_a_key = rotA.public_key;

  // 3. Echo target and worker A.
  banner("3. echo target and worker A start");
  start("echo", "agents/dist/src/echo-target.js", ["--port", String(ECHO_PORT), "--fail-rate", "0.3", "--outage-file", OUTAGE_FILE]);
  start("worker-a", "worker/dist/src/cli.js", ["--vault", VAULT, "--network", "testnet", "--port", String(PORT_A), "--key-file", KEY_A, "--allow-target", `127.0.0.1:${ECHO_PORT}`, "--flush-ms", "15000", "--watch-ms", "30000", "--data-dir", path.join(LOGS, "worker-a-data")]);
  const healthA = await waitHealth(ENDPOINT_A, 60_000);
  say(`worker A healthy: key ${healthA.worker_public_key}, price ${healthA.price_per_call}`);

  // 4. Traffic: alice and bob start without credit, get 402, top up and keep sending.
  banner("4. traffic: alice and bob send deliveries (first call answers 402, the SDK tops up)");
  const trafficArgs = ["--vault", VAULT, "--customers", `${A.alice},${A.bob}`, "--target", `http://127.0.0.1:${ECHO_PORT}/hook`, "--rate", "0.4", "--top-up", "5", "--track-ms", "15000", "--summary", path.join(LOGS, "traffic-summary.json")];
  start("traffic", "agents/dist/src/traffic.js", trafficArgs);
  const tickEnd = Date.now() + TRAFFIC_SEC * 1000;
  while (Date.now() < tickEnd) {
    await sleep(15_000);
    const info = await view(VAULT, "get_info");
    say(`revenue ticking: vault revenue ${fmt(info.revenue)} tUSDC, customer credit ${fmt(info.liabilities)}, ${info.customers} customers, ${info.charged_items} charges`);
  }
  // Bank real recognized revenue before the story moves on: the buyer sizes
  // the business from charged revenue, and the first top-up can eat most of
  // the traffic window while its transaction queues behind the RPC budget.
  const revEnd = Date.now() + 600_000;
  let rev = await view(VAULT, "get_info");
  while (Number(rev.revenue) < 450_000 && Date.now() < revEnd) {
    await sleep(15_000);
    rev = await view(VAULT, "get_info");
    say(`charges landing: vault revenue ${fmt(rev.revenue)} tUSDC, ${rev.charged_items} charges`);
  }
  const deposits = [...logText("traffic").matchAll(/topped up .* (https:\/\/\S+)/g)].map((m) => m[1]);
  record.links.customer_deposits = deposits;
  for (const link of deposits) step("customer deposit after a 402 (ft_transfer_call)", { tx: link.split("/").pop(), success: true });
  const chargesA = chargeTxs("worker-a");
  if (chargesA.length > 0) step(`worker A charges a batch (${chargesA[0].charged} items, signed by the worker key)`, { tx: chargesA[0].tx, success: chargesA[0].charged > 0 });
  record.worker_a_charge_txs = chargesA.map((c) => c.tx);
  // The shared public-RPC budget is tight; pause the customers while the
  // owner and buyer do their transactions, then bring them back for the
  // outage beat where deliveries must pile up in worker A's queue.
  stop("traffic");
  await waitExit("traffic", 120_000);

  // 5. Dynamic NFT: push the stats so the certificate shows the numbers.
  banner("5. stats pushed to the token; the NFT certificate updates");
  const push1 = await run("agents/dist/src/owner.js", ["push-stats", "--as", A.seller, "--vault", VAULT], "05-push-stats");
  step("push_stats updates the dynamic NFT metadata", { tx: push1.tx, success: push1.success });
  const outliveView = await view(OUTLIVE, "get_token", { token_id: SLUG });
  say(`outlive stats now: ${outliveView.stats?.calls_30d} calls, revenue ${fmt(outliveView.stats?.revenue_30d ?? "0")} tUSDC`);

  // 6. The seller takes the cash out, then lists.
  banner("6. seller withdraws revenue, then lists the token (the vault locks)");
  const w1 = await run("agents/dist/src/owner.js", ["withdraw", "--as", A.seller, "--vault", VAULT, "--amount", "all"], "06-seller-withdraw");
  step("seller withdraws revenue before listing", { tx: w1.tx, success: w1.success });
  const list = await run("agents/dist/src/owner.js", ["list", "--as", A.seller, "--token-id", SLUG, "--price", LIST_PRICE], "06-list");
  step(`seller lists ${SLUG} for ${LIST_PRICE} tUSDC`, { tx: list.tx, success: list.success && list.listing?.active === true });
  await sleep(20_000); // a little more revenue accrues to the vault while listed

  // 7. The buyer agent decides and buys.
  banner("7. buyer agent appraises independent revenue (demo policy), computes payback on chain-visible costs, gets a 1Click mainnet dry quote (nothing executed), buys");
  // The demo policy relaxes the thresholds for a 10-minute run (2 customers, 80% share, no
  // minimum age); the agent prints that every time. The default policy is strict.
  const buy = await run("agents/dist/src/buyer.js", ["--account", A.buyer, "--token-id", SLUG, "--policy", "demo", "--max-payback-days", "30", "--fund-from", "eth:usdc", "--refund-to", "0x1111111111111111111111111111111111111111", "--mint-if-short"], "07-buyer");
  step(`buyer agent buys ${SLUG}`, { tx: buy.buy_tx, success: buy.bought === true, note: buy.evaluated?.[0] ? `payback on chain-visible costs ${Number(buy.evaluated[0].payback_days).toFixed(2)} days on independent revenue ${fmt(buy.evaluated[0].independent_revenue_30d ?? "0")} tUSDC, policy ${buy.policy?.name}` : undefined });
  record.buyer = { decision: buy.decision, policy: buy.policy ?? null, evaluated: buy.evaluated, funding_quote_label: "mainnet dry quote (dry:true), nothing executed", funding_quote: buy.funding_quote?.quote ?? null, funding_quote_error: buy.funding_quote_error ?? null };
  if (!buy.bought) throw new Error("the buyer did not buy");

  // 8. Revenue now accrues to the buyer; the seller's withdraw reverts.
  banner("8. the seller's withdraw now reverts");
  await sleep(8_000);
  const w2 = await run("agents/dist/src/owner.js", ["withdraw", "--as", A.seller, "--vault", VAULT, "--amount", "0.000001"], "08-seller-withdraw-fails");
  step("seller withdraw after the sale reverts (only the token owner)", { tx: w2.tx, success: w2.success, expect: "failure" });

  // 9. Worker B: start it first, then rotate key and endpoint in one transaction.
  banner("9. buyer starts worker B and rotates key and endpoint in one transaction");
  // A short outage at the target, so worker A holds paid but undelivered obligations at the
  // moment of the handover. The customers come back too: their deliveries are what piles up.
  start("traffic", "agents/dist/src/traffic.js", trafficArgs);
  fs.writeFileSync(OUTAGE_FILE, "");
  say("the echo target is down for a while (simulated outage): deliveries pile up in worker A's queue");
  await sleep(15_000);
  const kg = await run("agents/dist/src/owner.js", ["keygen", "--as", A.buyer, "--vault", VAULT, "--key-file", KEY_B], "09-keygen");
  record.worker_b_key = kg.public_key;
  start("worker-b", "worker/dist/src/cli.js", ["--vault", VAULT, "--network", "testnet", "--port", String(PORT_B), "--key-file", KEY_B, "--allow-target", `127.0.0.1:${ECHO_PORT}`, "--flush-ms", "15000", "--watch-ms", "30000", "--wait-for-key", "180", "--data-dir", path.join(LOGS, "worker-b-data")]);
  const rotB = await run("agents/dist/src/owner.js", ["rotate", "--as", A.buyer, "--vault", VAULT, "--endpoint", ENDPOINT_B, "--key-file", KEY_B], "09-rotate");
  step("buyer rotates the worker key and endpoint in one transaction", { tx: rotB.tx, success: rotB.success });
  await waitHealth(ENDPOINT_B, 90_000);
  say("worker B is serving");

  // 10. Worker A notices, hands its queue to B and exits by itself.
  banner("10. worker A sees the new key on chain, hands off its pending queue, exits");
  const aExited = await waitExit("worker-a", 120_000);
  const aLog = logText("worker-a");
  const handoff = aLog.match(/hand-off to .*/)?.[0] ?? aLog.match(/no hand-off.*/)?.[0] ?? "(no hand-off line)";
  step("worker A stops by itself after the rotation", { success: aExited, note: handoff });
  // Open obligations reach B two ways: A's signed hand-off and customers presenting their
  // receipts after a 410. Whichever comes first takes them over; the other finds them known.
  const bLines = [...logText("worker-b").matchAll(/(hand-off received from the previous worker|receipts presented by \S+): .*/g)].map((m) => m[0]);
  const handed = handoff.match(/(\d+) of (\d+) obligations taken over/);
  const takenOver = handed !== null && Number(handed[2]) > 0 && handed[1] === handed[2];
  step("worker B holds every open obligation of worker A", { success: takenOver, note: bLines.join("; ") || "no lines" });
  record.handoff = { worker_a: handoff, worker_b: bLines };
  await sleep(5_000);
  fs.rmSync(OUTAGE_FILE, { force: true });
  say("the echo target is back: worker B delivers the obligations it took over");
  const keysAfter = await accessKeys(VAULT);
  record.vault_keys_after_rotation = keysAfter ? keysAfter.keys.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission })) : null;

  // 11. Traffic continues through B.
  banner("11. traffic continues through worker B");
  const afterEnd = Date.now() + AFTER_SEC * 1000;
  while (Date.now() < afterEnd) {
    await sleep(15_000);
    const info = await view(VAULT, "get_info");
    say(`vault revenue ${fmt(info.revenue)} tUSDC (now the buyer's), ${info.charged_items} charges, endpoint ${info.endpoint}`);
  }
  stop("traffic");
  say("traffic stopping: it waits until every pending obligation is delivered");
  await waitExit("traffic", 300_000);
  const summary = fs.existsSync(path.join(LOGS, "traffic-summary.json")) ? JSON.parse(fs.readFileSync(path.join(LOGS, "traffic-summary.json"), "utf8")) : null;
  record.traffic = summary;
  const pending = summary ? summary.customers.reduce((n, c) => n + c.pending, 0) : -1;
  const workersSeen = summary ? new Set(summary.customers.flatMap((c) => Object.keys(c.receipts_by_worker))).size : 0;
  step("every pending obligation was delivered", { success: pending === 0, note: summary ? summary.customers.map((c) => `${c.customer}: ${c.accepted} accepted, ${c.delivered} delivered, ${c.failed} failed`).join("; ") : "no summary" });
  step("receipts were signed by both workers", { success: workersSeen >= 2, note: `${workersSeen} worker keys` });
  await sleep(6_000); // last charge batch of B
  const chargesB = chargeTxs("worker-b");
  if (chargesB.length > 0) step(`worker B charges with the new key (${chargesB[0].charged} items)`, { tx: chargesB[0].tx, success: chargesB[0].charged > 0 });
  record.worker_b_charge_txs = chargesB.map((c) => c.tx);

  // 12. The buyer withdraws and the certificate is refreshed.
  banner("12. buyer withdraws the revenue");
  const w3 = await run("agents/dist/src/owner.js", ["withdraw", "--as", A.buyer, "--vault", VAULT, "--amount", "all"], "12-buyer-withdraw");
  step("buyer withdraws revenue", { tx: w3.tx, success: w3.success });
  const push2 = await run("agents/dist/src/owner.js", ["push-stats", "--as", A.buyer, "--vault", VAULT], "12-push-stats");
  step("push_stats after the sale", { tx: push2.tx, success: push2.success });
  const finalInfo = await view(VAULT, "get_info");
  const finalStats = await view(VAULT, "get_stats");
  record.final = { owner: finalInfo.owner_id, owner_epoch: finalInfo.owner_epoch, worker_key: finalInfo.worker_key, endpoint: finalInfo.endpoint, revenue: finalInfo.revenue, liabilities: finalInfo.liabilities, calls_30d: finalStats.calls_30d, revenue_30d: finalStats.revenue_30d, gas_spent_30d: finalStats.gas_spent_30d };
  say(`final: owner ${finalInfo.owner_id} (epoch ${finalInfo.owner_epoch}), ${finalStats.calls_30d} calls, revenue ${fmt(finalStats.revenue_30d)} tUSDC over the run`);
}

async function cleanup() {
  for (const name of ["traffic", "worker-a", "worker-b", "echo"]) stop(name);
  for (const name of ["traffic", "worker-a", "worker-b", "echo"]) {
    if (!(await waitExit(name, 10_000))) stop(name, "SIGKILL");
  }
}

let failed = null;
try {
  await main();
} catch (e) {
  failed = e instanceof Error ? e.message : String(e);
  say(`demo failed: ${failed}`);
} finally {
  await cleanup();
  record.finished_at = new Date().toISOString();
  record.ok = failed === null && record.steps.every((s) => s.ok);
  if (failed) record.error = failed;
  record.logs = `demo-logs/${RUN}/ (local only)`;
  const d = loadDeployments();
  d.demo_runs = [...(d.demo_runs || []), { run: RUN, ok: record.ok, finished_at: record.finished_at, ...(failed ? { error: failed } : {}) }];
  if (record.ok || !d.demo) d.demo = record;
  saveDeployments(d);
  say(`all local processes stopped. Demo ${record.ok ? "passed" : "FAILED"}; recorded in deployments/testnet.json${record.ok ? ' under "demo"' : ""}`);
  demoLog.end();
  process.exitCode = record.ok ? 0 : 1;
}
