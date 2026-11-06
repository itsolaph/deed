#!/usr/bin/env node
// Usage: node scripts/reconcile-run.mjs <run-dir> [--vault <id>] [--price-per-call <micro>]
// Offline by default. No credentials are needed, including for public on-chain views.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { reconcile, rotationCoverage } from './lib/reconcile.mjs';

/** Worker identity is its *-data directory, not a log event or a receipt presentation. */
export function loadRunJournals(runDir, { allowPartialTail = false } = {}) {
  const workers = [];
  for (const entry of fs.readdirSync(runDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !/^worker-.+-data$/.test(entry.name)) continue;
    const dir = path.join(runDir, entry.name);
    const files = fs.readdirSync(dir).filter((f) => /^journal-.*\.jsonl$/.test(f)).sort();
    if (!files.length) continue;
    const rows = [];
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); }
        catch (cause) {
          // A live append can be caught mid-record. Never mutate/truncate evidence.
          if (allowPartialTail && index === lines.length - 1) break;
          throw new Error(`${fullPath}:${index + 1}: invalid journal JSON`, { cause });
        }
      }
    }
    workers.push({ worker: entry.name.replace(/-data$/, ''), rows });
  }
  if (!workers.length) throw new Error(`no worker journals in ${runDir}`);
  return workers;
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    vault: { type: 'string' }, 'price-per-call': { type: 'string' },
  } });
  if (positionals.length !== 1) throw new Error('usage: node scripts/reconcile-run.mjs <run-dir> [--vault <id>] [--price-per-call <micro>]');
  const workers = loadRunJournals(path.resolve(positionals[0]));
  const prices = new Set(workers.flatMap(({ rows }) => rows.filter((r) => r.t === 'accepted').map((r) => r.receipt.payload.price)));
  const pricePerCall = values['price-per-call'] ?? (prices.size === 1 ? [...prices][0] : undefined);
  if (!pricePerCall || !/^\d+$/.test(pricePerCall)) throw new Error('a single integer receipt price or --price-per-call <micro> is required');
  const report = reconcile(workers, { vault: values.vault, pricePerCall });
  const { totals } = report;
  console.log(`identities: ${totals.distinct}; accepted: ${totals.accepted}; delivered: ${totals.delivered}; charged: ${totals.charged}`);
  const list = (label, ids) => console.log(`${label}: ${ids.length}${ids.length ? ` [${ids.join(', ')}]` : ''}`);
  list('accepted but never charged', report.acceptedButNeverChargedIds);
  list('charged but not delivered', report.chargedButNotDeliveredIds);
  console.log(`present in multiple workers: ${report.multiWorkerIds.length} (normal during rotation)`);
  list('charged by multiple workers', report.multiWorkerChargedIds);
  list('sequence conflicts across workers', report.seqConflictIds);
  console.log(`customer/sequence collisions: ${report.sequenceCollisions.length}${report.sequenceCollisions.length ? ` ${JSON.stringify(report.sequenceCollisions)}` : ''}`);
  let ok = report.acceptedButNeverChargedIds.length === 0 && report.chargedButNotDeliveredIds.length === 0 &&
    report.multiWorkerChargedIds.length === 0 && report.seqConflictIds.length === 0 && report.sequenceCollisions.length === 0;
  if (report.workers['worker-a'] && report.workers['worker-b']) {
    const coverage = rotationCoverage(report, 'worker-a', 'worker-b');
    console.log(`rotation worker-a -> worker-b: ${coverage.heldIds.length}/${coverage.originalIds.length} original open identities held once; missing: ${coverage.missingIds.length}`);
    if (coverage.missingIds.length) list('missing original identities', coverage.missingIds);
    ok &&= coverage.ok;
  }
  console.log(`price per call: ${pricePerCall} micro; expected revenue: ${totals.expectedRevenue} micro`);
  for (const [customer, c] of Object.entries(report.perCustomer)) {
    console.log(`${customer}: ${c.accepted} accepted, ${c.delivered} delivered, ${c.charged} charged`);
  }
  if (values.vault) {
    const { view } = await import('./lib/near.mjs');
    const stats = await view(values.vault, 'get_stats');
    const matches = BigInt(stats.calls_total) === BigInt(totals.charged) &&
      BigInt(stats.revenue_total) === BigInt(totals.expectedRevenue);
    console.log(`on-chain: ${matches ? 'MATCH' : 'MISMATCH'}; calls_total: ${stats.calls_total} vs ${totals.charged}; revenue_total: ${stats.revenue_total} vs ${totals.expectedRevenue} micro`);
    ok &&= matches;
  } else {
    console.log('on-chain: not checked (use --vault <id>)');
  }
  return { report, ok };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const { ok } = await main(); process.exitCode = ok ? 0 : 1; }
  catch (error) { console.error(`reconcile: ${error.message}`); process.exitCode = 1; }
}
