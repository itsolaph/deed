import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import vm from 'node:vm';

import * as reconciliation from '../lib/reconcile.mjs';
const options = { vault: 'relay.testnet', pricePerCall: '10000' };
const accepted = (id, customer = 'alice', seq = 1) => ({
  t: 'accepted', id, request: {}, charge: true,
  receipt: { payload: { receipt_version: 2, delivery_id: id, vault: options.vault, customer, seq, price: '10000' }, signature: 'fixture' },
});
const attempt = (id, status_code = 200, at = 1) => ({
  t: 'attempt', id, proof: { payload: { delivery_id: id, vault: options.vault, attempt: 1, status_code, at } },
});
const charged = (id, seq = 1, status = 'charged') => ({ t: 'charged', id, seq, status, tx: 'fixture-tx' });
const worker = (worker, rows) => ({ worker, rows });

test('a clean single-worker run reconciles accepted, delivered and charged identities', () => {
  assert.equal(typeof reconciliation.reconcile, 'function');
  const rows = [accepted('a'), attempt('a'), charged('a'), accepted('b', 'bob'), attempt('b'), charged('b')];
  const before = structuredClone(rows);
  const report = reconciliation.reconcile([worker('a', rows)], options);
  assert.deepEqual(report.deliveryIds, ['a', 'b']);
  assert.deepEqual(report.acceptedIds, report.deliveryIds);
  assert.deepEqual(report.deliveredIds, report.deliveryIds);
  assert.deepEqual(report.chargedIds, report.deliveryIds);
  assert.deepEqual(report.totals, { distinct: 2, accepted: 2, delivered: 2, charged: 2, expectedRevenue: '20000' });
  assert.deepEqual(report.perCustomer, {
    alice: { distinct: 1, accepted: 1, delivered: 1, charged: 1, expectedRevenue: '10000' },
    bob: { distinct: 1, accepted: 1, delivered: 1, charged: 1, expectedRevenue: '10000' },
  });
  assert.deepEqual(rows, before, 'the reconciliation core must not mutate input');
});

test('a genuine double charge reports the same id charged by both workers', () => {
  const report = reconciliation.reconcile([
    worker('a', [accepted('shared'), attempt('shared'), charged('shared')]),
    worker('b', [accepted('shared'), charged('shared')]),
  ], options);
  assert.deepEqual(report.multiWorkerIds, ['shared']);
  assert.deepEqual(report.multiWorkerChargedIds, ['shared']);
  assert.deepEqual(report.deliveries[0].chargedBy, ['a', 'b']);
  assert.equal(report.totals.charged, 1, 'identity totals must not count debit events');
});

test('a delivery assigned conflicting sequences across workers is reported', () => {
  const report = reconciliation.reconcile([
    worker('a', [accepted('shared', 'alice', 1), charged('shared', 1)]),
    worker('b', [accepted('shared', 'alice', 2)]),
  ], options);
  assert.deepEqual(report.seqConflictIds, ['shared']);
  assert.deepEqual(report.deliveries[0].sequenceClaims, [
    { worker: 'a', customer: 'alice', seq: '1' },
    { worker: 'b', customer: 'alice', seq: '2' },
  ]);
});

test('two different ids claiming a customer sequence collide even within one worker', () => {
  const report = reconciliation.reconcile([
    worker('a', [accepted('one', 'alice', 7), accepted('two', 'alice', 7), accepted('bob', 'bob', 7)]),
    worker('b', [accepted('one', 'alice', 7)]),
  ], options);
  assert.deepEqual(report.sequenceCollisions, [{ customer: 'alice', seq: '7', deliveryIds: ['one', 'two'] }]);
  assert.deepEqual(report.seqConflictIds, []);
});

test('accepted obligations without a successful debit remain never charged', () => {
  const report = reconciliation.reconcile([worker('a', [
    accepted('pending'),
    accepted('delivered', 'alice', 2), attempt('delivered'),
    accepted('duplicate', 'alice', 3), charged('duplicate', 3, 'duplicate'),
    accepted('paid', 'alice', 4), attempt('paid', 503), charged('paid', 4),
  ])], options);
  assert.deepEqual(report.acceptedButNeverChargedIds, ['delivered', 'duplicate', 'pending']);
  assert.deepEqual(report.chargedButNotDeliveredIds, ['paid']);
});

test('overlapping customer presentations and hand-off coverage hold each original identity once', () => {
  assert.equal(typeof reconciliation.rotationCoverage, 'function');
  const a = [];
  const b = [];
  for (let n = 1; n <= 40; n++) {
    const id = `delivery-${String(n).padStart(2, '0')}`;
    a.push(accepted(id, 'alice', n), attempt(id, 503));
    if (n <= 16) a.push(charged(id, n));
    b.push({ ...accepted(id, 'alice', n), charge: n > 16 }, attempt(id, 200, 2));
    if (n > 16) b.push(charged(id, n));
  }
  // A retry/presentation can repeat coverage, but not create another identity or debit.
  b.push(accepted('delivery-01', 'alice', 1), accepted('delivery-02', 'alice', 2));
  const journals = [worker('a', a), worker('b', b)];
  const report = reconciliation.reconcile(journals, options);
  assert.equal(report.multiWorkerIds.length, 40, 'cross-worker presence is expected, not double charging');
  assert.deepEqual(report.multiWorkerChargedIds, []);
  assert.deepEqual(report.sequenceCollisions, []);
  assert.deepEqual(report.seqConflictIds, []);
  assert.equal(report.totals.charged, 40);
  const coverage = reconciliation.rotationCoverage(report, 'a', 'b');
  assert.equal(coverage.originalIds.length, 40);
  assert.equal(coverage.heldIds.length, 40, '42 presentation/hand-off events still cover only 40 identities');
  assert.deepEqual(coverage.missingIds, []);
  assert.equal(coverage.ok, true);

  const missing = reconciliation.rotationCoverage(reconciliation.reconcile([
    worker('a', a), worker('b', b.filter((r) => r.id !== 'delivery-40').concat(accepted('unrelated', 'bob', 1))),
  ], options), 'a', 'b');
  assert.equal(missing.ok, false, 'an unrelated identity cannot compensate for a missing obligation');
  assert.deepEqual(missing.missingIds, ['delivery-40']);

  const doubled = reconciliation.rotationCoverage(reconciliation.reconcile([
    worker('a', a), worker('b', [...b, charged('delivery-01')]),
  ], options), 'a', 'b');
  assert.equal(doubled.ok, false);
  assert.deepEqual(doubled.doubleChargedIds, ['delivery-01']);
});

test('final proof is selected by time, not worker enumeration or reset attempt number', () => {
  const first = worker('a', [accepted('shared'), attempt('shared', 503, 10)]);
  first.rows[1].proof.payload.attempt = 8;
  const second = worker('b', [accepted('shared'), attempt('shared', 200, 20)]);
  const forward = reconciliation.reconcile([first, second], options);
  const reverse = reconciliation.reconcile([second, first], options);
  assert.deepEqual(reverse.deliveredIds, ['shared']);
  assert.deepEqual(reverse.deliveredIds, forward.deliveredIds);
  const failedLater = reconciliation.reconcile([
    worker('a', [accepted('x'), attempt('x', 200, 1), attempt('x', 503, 2), charged('x')]),
  ], options);
  assert.deepEqual(failedLater.deliveredIds, [], 'an earlier HTTP 200 does not replace the final proof');
});

test('settled charge sequences participate in conflicts and pair claims', () => {
  const report = reconciliation.reconcile([
    worker('a', [accepted('same', 'alice', 1), charged('same', 1)]),
    worker('b', [accepted('same', 'alice', 1), charged('same', 2), accepted('other', 'alice', 2)]),
  ], options);
  assert.deepEqual(report.seqConflictIds, ['same']);
  assert.deepEqual(report.sequenceCollisions, [{ customer: 'alice', seq: '2', deliveryIds: ['other', 'same'] }]);
});

function fixtureRun(t, journals) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outlive-reconcile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const { worker, rows } of journals) {
    const data = path.join(dir, `${worker}-data`);
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'journal-fixture.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return dir;
}

async function cli(args, env = {}) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../reconcile-run.mjs', import.meta.url)), ...args], {
    env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  return { code, stdout, stderr };
}

test('standalone CLI loads worker journals and prints a compact identity report', async (t) => {
  const dir = fixtureRun(t, [
    worker('worker-a', [accepted('one'), attempt('one', 503), charged('one')]),
    worker('worker-b', [{ ...accepted('one'), charge: false }, attempt('one', 200, 2), accepted('two', 'bob'), charged('two'), attempt('two')]),
  ]);
  const result = await cli([dir]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /identities: 2; accepted: 2; delivered: 2; charged: 2/);
  assert.match(result.stdout, /present in multiple workers: 1 \(normal during rotation\)/);
  assert.match(result.stdout, /charged by multiple workers: 0/);
  assert.match(result.stdout, /rotation worker-a -> worker-b: 1\/1 original open identities held once; missing: 0/);
  assert.match(result.stdout, /expected revenue: 20000 micro/);
  assert.match(result.stdout, /alice: 1 accepted, 1 delivered, 1 charged/);
  assert.match(result.stdout, /on-chain: not checked/);
});

test('--vault checks both lifetime calls and integer revenue through the real view helper', async (t) => {
  const dir = fixtureRun(t, [worker('worker-a', [accepted('one'), attempt('one'), charged('one')])]);
  let stats = { calls_total: 1, revenue_total: '10000' };
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push(request);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {
      block_height: 1, block_hash: '11111111111111111111111111111111', logs: [],
      result: [...Buffer.from(JSON.stringify(stats))],
    } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { NEAR_RPC_URLS: `http://127.0.0.1:${server.address().port}` };
  const good = await cli([dir, '--vault', options.vault], env);
  assert.equal(good.code, 0, good.stderr);
  assert.match(good.stdout, /on-chain: MATCH; calls_total: 1 vs 1; revenue_total: 10000 vs 10000 micro/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].params.account_id, options.vault);
  assert.equal(requests[0].params.method_name, 'get_stats');
  for (const wrong of [{ calls_total: 2, revenue_total: '10000' }, { calls_total: 1, revenue_total: '10001' }]) {
    stats = wrong;
    const mismatch = await cli([dir, '--vault', options.vault], env);
    assert.equal(mismatch.code, 1, mismatch.stderr);
    assert.match(mismatch.stdout, /on-chain: MISMATCH/);
  }
});

test('demo step 10 polls late presentations but asserts journal identity coverage, not 42 events', async () => {
  const source = fs.readFileSync(new URL('../demo-testnet.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('  // 10.');
  const end = source.indexOf('  await sleep(5_000);', start);
  assert.ok(start > 0 && end > start);
  const steps = [];
  const record = {};
  let polls = 0;
  const a = Array.from({ length: 40 }, (_, n) => accepted(`id-${n}`, 'alice', n + 1));
  const b = a.map((r) => ({ ...r, charge: true }));
  const context = {
    banner() {}, waitExit: async () => true,
    logText: (name) => name === 'worker-a'
      ? 'hand-off to endpoint: 18 of 40 obligations taken over'
      : `hand-off received from the previous worker: 18 taken over (0 charged as new)${polls ? '\nreceipts presented by alice: 24 taken over (24 charged as new), 2 already here' : ''}`,
    step: (name, data) => steps.push({ name, ...data }),
    sleep: async () => { polls++; },
    loadRunJournals: () => [worker('worker-a', a), worker('worker-b', polls ? b : b.slice(0, 18))],
    reconcile: reconciliation.reconcile, rotationCoverage: reconciliation.rotationCoverage,
    VAULT: options.vault, LOGS: '/synthetic', healthA: { price_per_call: '10000' }, record,
  };
  await vm.runInNewContext(`(async () => {${source.slice(start, end)}\n})()`, context);
  assert.equal(polls, 1, 'late receipt lines and their journal entries are still polled');
  const coverage = steps.find((s) => s.name === 'worker B holds every open obligation of worker A');
  assert.equal(coverage.success, true);
  assert.match(coverage.note, /40 of 40 distinct open delivery ids held once; 0 missing; 0 ids charged by both workers/);
  assert.doesNotMatch(coverage.note, /42 of 40|via customer presentations/);
  assert.equal(record.handoff.identity_coverage.heldIds.length, 40);
});

test('vault scope refuses foreign receipts rather than leaving their unbound charge rows', () => {
  const foreign = accepted('foreign');
  foreign.receipt.payload.vault = 'other.testnet';
  assert.throws(() => reconciliation.reconcile([
    worker('a', [foreign, charged('foreign')]),
  ], options), /vault mismatch/);
});

test('rotation evidence fails closed if either worker journal is unavailable', () => {
  const report = reconciliation.reconcile([worker('worker-a', [])], options);
  const coverage = reconciliation.rotationCoverage(report, 'worker-a', 'worker-b');
  assert.equal(coverage.ok, false);
  assert.deepEqual(coverage.unavailableWorkers, ['worker-b']);
});

test('live journal polling may defer an incomplete tail but never ignores complete corrupt lines', async (t) => {
  const { loadRunJournals } = await import('../reconcile-run.mjs');
  const dir = fixtureRun(t, [worker('worker-a', [accepted('one')])]);
  const file = path.join(dir, 'worker-a-data', 'journal-fixture.jsonl');
  fs.appendFileSync(file, '{"t":"attempt"');
  assert.throws(() => loadRunJournals(dir), /:2: invalid journal JSON/);
  assert.equal(loadRunJournals(dir, { allowPartialTail: true })[0].rows.length, 1);
  fs.appendFileSync(file, '\n');
  assert.throws(() => loadRunJournals(dir, { allowPartialTail: true }), /:2: invalid journal JSON/);
});
