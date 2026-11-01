#!/usr/bin/env node
// traffic: relay customers (alice and bob by default) send deliveries continuously through
// the SDK and print a compact live log. Keeps every obligation receipt until its delivery is
// confirmed, follows the vault to a new worker on 410 or a dead endpoint, and on SIGTERM
// waits for its pending deliveries before printing a summary.
//
//   node agents/dist/src/traffic.js --vault relay.deed2.deedlab.testnet \
//     --customers deedlab-alice.testnet,deedlab-bob.testnet --target http://127.0.0.1:7611/hook

import { parseArgs } from "node:util";
import { DeedClient, PaymentRequiredError, fromUnits, randomBytes, toHex } from "@deed/sdk";
import { createNodeTransactor } from "@deed/sdk/node";
import { clock, isMain, messageSigner, rpc, runMain, txLink, txSigner, withRpcRetry, writeJson } from "./common.js";

interface CustomerRun {
  name: string;
  client: DeedClient;
  sent: number;
  accepted: number;
  refused402: number;
  errors: number;
  delivered: number;
  failed: number;
  byWorker: Map<string, number>;
  lastTopUp: number;
}

const TOP_UP_COOLDOWN_MS = 30_000;
const TRACK_INTERVAL_MS = 3_000;
const SUMMARY_INTERVAL_MS = 15_000;
const DRAIN_TIMEOUT_MS = 240_000;

function short(account: string): string {
  return account.replace(/^deedlab-/, "").replace(/\.testnet$/, "");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      vault: { type: "string" },
      customers: { type: "string" },
      target: { type: "string", default: "http://127.0.0.1:7611/hook" },
      rate: { type: "string", default: "0.5" },
      "top-up": { type: "string", default: "5" },
      duration: { type: "string", default: "0" },
      summary: { type: "string" },
      "track-ms": { type: "string", default: String(TRACK_INTERVAL_MS) },
    },
  });
  if (!values.vault || !values.customers) throw new Error("usage: traffic --vault <account> --customers a,b [--target url] [--rate per-sec] [--top-up tUSDC] [--duration sec] [--summary file] [--track-ms ms]");
  const vault = values.vault;
  const r = rpc();
  const runId = toHex(randomBytes(3));
  const topUp = fromUnits(values["top-up"]!, 6);
  const intervalMs = Math.max(200, Math.round(1000 / Number(values.rate)));
  const log = (line: string) => process.stdout.write(`${clock()} [traffic] ${line}\n`);

  const runs: CustomerRun[] = values.customers.split(",").map((account) => {
    const name = short(account);
    const client = new DeedClient({
      vault,
      accountId: account,
      signer: messageSigner(account),
      rpc: r,
      transactor: createNodeTransactor(txSigner(account)),
      onEvent: (event, detail) => log(`${name}: ${event} ${JSON.stringify(detail)}`),
    });
    return { name, client, sent: 0, accepted: 0, refused402: 0, errors: 0, delivered: 0, failed: 0, byWorker: new Map(), lastTopUp: 0 };
  });

  let stopping = false;
  const timers: NodeJS.Timeout[] = [];

  async function sendOne(run: CustomerRun): Promise<void> {
    const n = ++run.sent;
    const body = JSON.stringify({ from: run.name, n, sent_at: new Date().toISOString() });
    try {
      const res = await run.client.deliver({ url: `${values.target}?from=${run.name}&n=${n}`, method: "POST", headers: { "x-demo": "deed" }, body, idempotency_key: `${run.name}-${runId}-${n}` });
      run.accepted += 1;
      const key = res.receipt.payload.worker_public_key.slice(8, 14);
      run.byWorker.set(key, (run.byWorker.get(key) ?? 0) + 1);
      log(`${run.name.padEnd(6)} #${n} 202 seq ${res.receipt.payload.seq} receipt signed by worker ${key}..`);
    } catch (e) {
      if (e instanceof PaymentRequiredError) {
        run.refused402 += 1;
        log(`${run.name.padEnd(6)} #${n} 402 ${e.details.reason} (price ${e.details.price_per_call}, min deposit ${e.details.min_deposit})`);
        const canPay = e.details.reason === "unknown_customer" || e.details.reason === "insufficient_balance";
        if (canPay && Date.now() - run.lastTopUp > TOP_UP_COOLDOWN_MS) {
          run.lastTopUp = Date.now();
          const tx = await withRpcRetry(() => run.client.topUp(topUp), 4, (line) => log(`${run.name.padEnd(6)} ${line}`));
          log(`${run.name.padEnd(6)} topped up ${values["top-up"]} tUSDC with ft_transfer_call: ${tx.success ? "ok" : "FAILED"} ${txLink(tx.hash)}`);
        }
        return;
      }
      run.errors += 1;
      log(`${run.name.padEnd(6)} #${n} error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function track(run: CustomerRun): Promise<void> {
    try {
      const t = await run.client.track();
      run.delivered += t.delivered.length;
      run.failed += t.failed.length;
    } catch (e) {
      log(`${run.name}: tracking failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const summary = () =>
    runs.map((x) => ({
      customer: x.name,
      sent: x.sent,
      accepted: x.accepted,
      refused_402: x.refused402,
      errors: x.errors,
      delivered: x.delivered,
      failed: x.failed,
      pending: x.client.pendingCount(),
      receipts_by_worker: Object.fromEntries(x.byWorker),
    }));
  const printSummary = () =>
    log(
      "summary " +
        summary()
          .map((s) => `${s.customer}: ${s.accepted} accepted, ${s.delivered} delivered, ${s.pending} pending, ${s.refused_402} x 402, workers ${JSON.stringify(s.receipts_by_worker)}`)
          .join(" | "),
    );

  for (const run of runs) {
    let busy = false;
    timers.push(
      setInterval(() => {
        if (stopping || busy) return;
        busy = true;
        void sendOne(run).finally(() => (busy = false));
      }, intervalMs),
    );
    let tracking = false;
    timers.push(
      setInterval(() => {
        if (tracking) return;
        tracking = true;
        void track(run).finally(() => (tracking = false));
      }, Number(values["track-ms"])),
    );
  }
  timers.push(setInterval(printSummary, SUMMARY_INTERVAL_MS));
  log(`sending to ${vault} as ${runs.map((x) => x.name).join(", ")} every ${intervalMs} ms each, target ${values.target}`);

  const finish = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`${reason}: no new deliveries; waiting for pending obligations to be delivered`);
    const end = Date.now() + DRAIN_TIMEOUT_MS;
    while (runs.some((x) => x.client.pendingCount() > 0) && Date.now() < end) {
      await new Promise((res) => setTimeout(res, TRACK_INTERVAL_MS));
      for (const run of runs) await track(run);
    }
    for (const t of timers) clearInterval(t);
    printSummary();
    writeJson(values.summary, { finished_at: new Date().toISOString(), customers: summary() });
    process.exit(0);
  };
  process.on("SIGTERM", () => void finish("SIGTERM"));
  process.on("SIGINT", () => void finish("SIGINT"));
  const duration = Number(values.duration);
  if (duration > 0) setTimeout(() => void finish("duration reached"), duration * 1000);
}

if (isMain(import.meta.url)) runMain("traffic", main);
