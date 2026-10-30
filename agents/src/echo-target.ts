#!/usr/bin/env node
// echo-target: a local webhook receiver that fails on purpose some of the time, so relay
// retries show. It checks the relay signature on every request and prints one line per hit.
//
//   node agents/dist/src/echo-target.js --port 7611 --fail-rate 0.3

import fs from "node:fs";
import http from "node:http";
import { parseArgs } from "node:util";
import { sha256Hex, verifyOutbound } from "@deed/sdk";
import { clock, isMain, runMain } from "./common.js";

export interface EchoOptions {
  port: number;
  host?: string;
  /** Share of first attempts answered with 503 (0..1). Retries of the same delivery succeed
   * (outside an outage), so the retry path shows without slowing the demo down. */
  failRate: number;
  /** While this file exists every request gets 503: a simulated outage, so deliveries pile
   * up in the relay queue (the demo uses it around the worker handover). */
  outageFile?: string | undefined;
  log?: (line: string) => void;
  random?: () => number;
}

export interface EchoStats {
  hits: number;
  ok: number;
  failed: number;
  badSignature: number;
  deliveries: Set<string>;
}

export function startEchoTarget(opts: EchoOptions): Promise<{ server: http.Server; stats: EchoStats }> {
  const log = opts.log ?? ((l: string) => process.stdout.write(l + "\n"));
  const random = opts.random ?? Math.random;
  const stats: EchoStats = { hits: 0, ok: 0, failed: 0, badSignature: 0, deliveries: new Set() };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const sig = verifyOutbound(req.headers, { method: req.method ?? "", path: req.url ?? "", bodySha256: sha256Hex(body) });
      stats.hits += 1;
      if (!sig.ok) stats.badSignature += 1;
      const attempt = Number(req.headers["x-deed-attempt"] ?? 1);
      const chance = attempt <= 1 ? opts.failRate : 0;
      const outage = opts.outageFile !== undefined && fs.existsSync(opts.outageFile);
      const fail = outage || random() < chance;
      if (fail) stats.failed += 1;
      else {
        stats.ok += 1;
        if (sig.deliveryId) stats.deliveries.add(sig.deliveryId);
      }
      res.writeHead(fail ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !fail }));
      const who = sig.key ? sig.key.slice(8, 16) : "unsigned";
      const why = outage ? "503 (outage)" : "503 (on purpose)";
      log(`${clock()} [echo] ${sig.deliveryId ?? "-"} attempt ${attempt} relay-sig ${sig.ok ? "ok" : "BAD"} key ${who}.. -> ${fail ? why : "200"}`);
    });
  });
  return new Promise((resolve) => server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve({ server, stats })));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "7611" },
      "fail-rate": { type: "string", default: "0.3" },
      "outage-file": { type: "string" },
      "pid-file": { type: "string" },
    },
  });
  const port = Number(values.port);
  const failRate = Number(values["fail-rate"]);
  await startEchoTarget({ port, failRate, outageFile: values["outage-file"] });
  process.stdout.write(`${clock()} [echo] listening on http://127.0.0.1:${port}, failing ${Math.round(failRate * 100)}% of first attempts on purpose\n`);
  if (values["pid-file"]) fs.writeFileSync(values["pid-file"], String(process.pid));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

if (isMain(import.meta.url)) runMain("echo-target", main);
