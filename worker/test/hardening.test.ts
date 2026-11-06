import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutliveClient, sha256Hex, generateSecretKey, signerFromSecretKey, signDocument, signReceipt, requestHash, HANDOFF_DOMAIN, type ObligationEntry } from '@outlive/sdk';
import { Worker } from '../src/worker.js';
import { Charger, type PendingCharge } from '../src/charger.js';
import { FakeVault } from './fake-vault.js';

const hooks = { onSettled: () => {}, onReseq: (i: PendingCharge) => i.receiptsRoot, onFloor: () => {}, onBatchFailed: () => {}, log: () => {} };
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function setup() {
  const fake = new FakeVault();
  const signer = signerFromSecretKey(generateSecretKey().secretKey);
  fake.setWorker(signer.publicKey);
  fake.addCustomer('alice.test', 'key', 1_000_000n);
  const chain = fake.as(signer.publicKey);
  const worker = new Worker({ vault: fake.vault, network: 'testnet', chain, signer, journalFile: null, publicUrl: 'http://localhost:1', allowTarget: '127.0.0.1:7620', handoff: false, log: () => {} });
  await worker.checkKey();
  const request = { url: 'http://127.0.0.1:7620/hook', method: 'POST', headers: { authorization: 'original' }, body: '{}', idempotency_key: 'one' };
  return { fake, signer, chain, worker, request };
}
test('confirmed charges reserve the actual chain debit after a price change', async () => {
  const { fake, chain } = await setup();
  const snapshot = fake.customerView('alice.test')!;
  const charger = new Charger(chain, hooks);
  await charger.admit('alice.test', 10_000n, () => ({ id: 'quoted', receiptsRoot: sha256Hex('r') }));
  fake.price = 20_000n;
  chain.customer = async () => snapshot;
  await charger.flush();
  assert.equal(fake.revenue, 20_000n);
  assert.equal(charger.available('alice.test')!.balance, 980_000n, 'reserve execution cost, not the earlier quote');
});

test('ambiguous changed-price settlement blocks admissions until a duplicate is visible on chain', async () => {
  const { fake, chain } = await setup();
  const snapshot = fake.customerView('alice.test')!;
  const apply = chain.charge.bind(chain);
  let first = true;
  chain.charge = async (items) => {
    const out = await apply(items);
    if (first) { first = false; throw new Error('response lost after settlement'); }
    return out;
  };
  const charger = new Charger(chain, hooks);
  await charger.admit('alice.test', 10_000n, () => ({ id: 'quoted', receiptsRoot: sha256Hex('r') }));
  fake.price = 20_000n;
  chain.customer = async () => snapshot;
  await charger.flush();
  await charger.flush();
  assert.equal(charger.pendingCount(), 0);
  const next = await charger.admit('alice.test', 985_000n, () => ({ id: 'next', receiptsRoot: sha256Hex('next') }));
  assert.equal(next.ok, false, 'a duplicate reveals no actual cost; stale balances are unsafe');
});

test('retirement during customer read prevents reservation', async () => {
  const { chain } = await setup(); const wait = gate(); const read = chain.customer.bind(chain);
  chain.customer = async c => { await wait.promise; return read(c); };
  const charger = new Charger(chain, hooks);
  const admission = charger.admit('alice.test', 1n, () => ({ id: 'a', receiptsRoot: sha256Hex('r') }));
  charger.stop(); wait.release();
  await assert.rejects(admission, /stopped/);
  assert.equal(charger.pendingCount(), 0);
});
for (const mode of ['throw', 'malformed', 'missing'] as const) test(`ambiguous ${mode} charge retries original sequence without double charge`, async () => {
  const { fake, chain } = await setup(); const charge = chain.charge.bind(chain); let first = true;
  chain.charge = async items => { const out = await charge(items); if (!first) return out; first = false; if (mode === 'throw') throw new Error('lost response'); return { ...out, results: mode === 'malformed' ? null as never : [] }; };
  const charger = new Charger(chain, hooks);
  await charger.admit('alice.test', fake.price, () => ({ id: 'a', receiptsRoot: sha256Hex('r') }));
  await charger.flush(); assert.equal(charger.pendingCount(), 1);
  await charger.flush(); assert.equal(charger.pendingCount(), 0);
  assert.equal(fake.revenue, fake.price); assert.equal(fake.charges[1]!.items[0]!.seq, 1);
});
test('idempotency conflicts reject sequential and concurrent changed requests', async () => {
  const { worker, request } = await setup();
  const a = worker.deliver('alice.test', request);
  const b = worker.deliver('alice.test', { ...request, method: 'DELETE' });
  assert.equal((await b).status, 409); assert.equal((await a).status, 202);
  assert.equal((await worker.deliver('alice.test', { ...request, headers: { authorization: 'changed' } })).status, 409);
  assert.equal((await worker.deliver('alice.test', request)).status, 200);
});
test('receipt binds method, headers and idempotency and rejects legacy takeover', async () => {
  const { worker, request, signer } = await setup();
  const reply = await worker.deliver('alice.test', request); const entry = { request, receipt: (reply.body as { receipt: ObligationEntry['receipt'] }).receipt };
  for (const mutation of [{ method: 'DELETE' }, { headers: { authorization: 'changed' } }, { idempotency_key: 'changed' }]) {
    const out = await worker.acceptObligations('alice.test', { entries: [{ ...entry, request: { ...request, ...mutation } }] });
    assert.equal((out.body as any).results[0].result, 'rejected');
  }
  const payload = { ...entry.receipt.payload } as any; delete payload.receipt_version; delete payload.request_sha256;
  const legacy = signReceipt(signer, payload);
  const out = await worker.acceptObligations('alice.test', { entries: [{ request, receipt: legacy }] });
  assert.equal((out.body as any).results[0].result, 'rejected');
});
test('concurrent customer and handoff takeover reserves once and validates every input', async () => {
  const old = await setup(); const accepted = await old.worker.deliver('alice.test', old.request);
  const entry = { request: old.request, receipt: (accepted.body as any).receipt };
  const signer = signerFromSecretKey(generateSecretKey().secretKey); old.fake.setWorker(signer.publicKey);
  const chain = old.fake.as(signer.publicKey); const wait = gate(); const entered = gate(); const read = chain.customer.bind(chain);
  chain.customer = async c => { entered.release(); await wait.promise; return read(c); };
  const worker = new Worker({ vault: old.fake.vault, network: 'testnet', chain, signer, journalFile: null, publicUrl: 'http://localhost:2', allowTarget: '127.0.0.1:7620', handoff: false, log: () => {} }); await worker.checkKey();
  const a = worker.acceptObligations('alice.test', { entries: [entry] }); await entered.promise;
  const b = worker.acceptHandoff(signDocument(HANDOFF_DOMAIN, old.signer, { vault: old.fake.vault, from_public_key: old.signer.publicKey, created_at: Date.now(), entries: [entry] }));
  const invalidPromise = worker.acceptObligations('alice.test', { entries: [{ ...entry, request: { ...old.request, method: 'DELETE' } }] });
  wait.release(); const invalid = await invalidPromise;
  await Promise.all([a, b]); await worker.flushCharges();
  assert.equal(old.fake.revenue, old.fake.price); assert.equal(old.fake.charges[0]!.items.length, 1);
  assert.equal((invalid.body as any).results[0].result, 'rejected');
});
test('worker retirement during admission returns 410', async () => {
  const { worker, fake, chain, request } = await setup(); const wait = gate(); const entered = gate(); const read = chain.customer.bind(chain);
  chain.customer = async c => { entered.release(); await wait.promise; return read(c); };
  const admission = worker.deliver('alice.test', request); await entered.promise;
  fake.setWorker('another-key'); await worker.watch(); wait.release();
  assert.equal((await admission).status, 410);
});

test('SDK rejects changed request and legacy receipts, accepts normalized equivalents', async () => {
  const { worker, fake, signer, request } = await setup();
  const reply = await worker.deliver('alice.test', request);
  const receipt = (reply.body as { receipt: ObligationEntry['receipt'] }).receipt;
  const client = new OutliveClient({ vault: fake.vault, accountId: 'alice.test', signer, views: { info: async () => fake.infoView(), workerHistory: async () => fake.history, customer: async c => fake.customerView(c) } });
  assert.ok(await client.verifyReceiptForVault(receipt, { ...request, headers: { authorization: 'changed' } }));
  assert.ok(await client.verifyReceiptForVault(receipt, { ...request, method: 'DELETE' }));
  assert.equal(await client.verifyReceiptForVault(receipt, { ...request, method: 'post', headers: { Authorization: 'original' } }), null);
  const { receipt_version, request_sha256, ...legacy } = receipt.payload;
  assert.ok(await client.verifyReceiptForVault(signReceipt(signer, legacy), request));
});

test('confirmed charges remain reserved through stale finalized views and views never regress seq', async () => {
  const { fake, chain } = await setup();
  const stale = fake.customerView('alice.test')!;
  let view = stale;
  chain.customer = async () => view;
  let now = 100_000;
  const charger = new Charger(chain, hooks, () => now);
  await charger.admit('alice.test', fake.price, () => ({ id: 'a', receiptsRoot: sha256Hex('r') }));
  await charger.flush();
  assert.equal((await charger.admit('alice.test', BigInt(stale.balance), () => ({ id: 'b', receiptsRoot: sha256Hex('s') }))).ok, false);
  view = fake.customerView('alice.test')!;
  // Flush forces refresh after a second real charge.
  await charger.admit('alice.test', fake.price, () => ({ id: 'c', receiptsRoot: sha256Hex('t') }));
  await charger.flush();
  const observed = charger.available('alice.test');
  view = stale;
  assert.equal(observed?.balance, 1_000_000n - 2n * fake.price);
  now += 30_001; await charger.refreshAll();
  assert.deepEqual(charger.available('alice.test'), observed);
  view = null as never; now += 30_001; await charger.refreshAll();
  assert.deepEqual(charger.available('alice.test'), observed);
});

for (const reason of ['insufficient_balance', 'daily_cap_reached', 'refund_pending', 'retired'] as const) test(`SDK persists real-worker ${reason} rejection and resubmits the same obligation`, async () => {
  const old = await setup();
  const accepted = await old.worker.deliver('alice.test', old.request);
  const entry: ObligationEntry = { request: old.request, receipt: (accepted.body as any).receipt };
  const signer = signerFromSecretKey(generateSecretKey().secretKey); old.fake.setWorker(signer.publicKey);
  const chain = old.fake.as(signer.publicKey);
  const worker = new Worker({ vault: old.fake.vault, network: 'testnet', chain, signer, journalFile: null, publicUrl: 'http://localhost:2', allowTarget: '127.0.0.1:7620', handoff: false, log: () => {} });
  await worker.checkKey();
  const customer = old.fake.customers.get('alice.test')!;
  if (reason === 'insufficient_balance') customer.balance = 0n;
  if (reason === 'daily_cap_reached') customer.cap = 0n;
  if (reason === 'refund_pending') customer.refundRequestedAt = 1;
  if (reason === 'retired') {
    const read = chain.customer.bind(chain);
    chain.customer = async (c: string) => { const view = await read(c); old.fake.setWorker(old.signer.publicKey); await worker.watch(); return view; };
  }
  let saved: ObligationEntry[] = [entry];
  let current = worker;
  const options = { vault: old.fake.vault, accountId: 'alice.test', signer: old.signer, endpoint: 'http://localhost:2', store: { load: () => saved, save: (entries: ObligationEntry[]) => { saved = structuredClone(entries); } }, views: { info: async () => old.fake.infoView(), workerHistory: async () => old.fake.history, customer: async (c: string) => old.fake.customerView(c) }, fetchImpl: (async (_url, init) => { const reply = await current.acceptObligations('alice.test', JSON.parse(String(init?.body))); return Response.json(reply.body, { status: reply.status }); }) as typeof fetch };
  const client = new OutliveClient(options);
  const rejected = await client.resubmit();
  assert.equal(rejected[0]!.result, 'rejected');
  assert.match(rejected[0]!.reason!, reason === 'retired' ? /worker retired/ : new RegExp(reason));
  assert.deepEqual(saved, [entry]);
  customer.balance = 1_000_000n; customer.cap = 10n ** 12n; customer.refundRequestedAt = null;
  // Fresh worker also removes the old admission cache, as on a handover/restart.
  old.fake.setWorker(signer.publicKey);
  current = new Worker({ vault: old.fake.vault, network: 'testnet', chain: old.fake.as(signer.publicKey), signer, journalFile: null, publicUrl: 'http://localhost:2', allowTarget: '127.0.0.1:7620', handoff: false, log: () => {} }); await current.checkKey();
  const restarted = new OutliveClient(options);
  const results = await restarted.resubmit();
  assert.equal(results[0]!.result, 'accepted');
  assert.equal(results[0]!.delivery_id, entry.receipt.payload.delivery_id);
  assert.deepEqual(restarted.pendingEntries()[0]!.request, entry.request);
  await current.flushCharges(); assert.equal(old.fake.revenue, old.fake.price);
});

for (const readBeforeCharge of [true, false]) test(`read/flush overlap stays conservative (snapshot before charge: ${readBeforeCharge})`, async () => {
  const { fake, chain } = await setup(); let now = 100_000;
  const charger = new Charger(chain, hooks, () => now);
  await charger.admit('alice.test', fake.price, () => ({ id: 'a', receiptsRoot: sha256Hex('r') }));
  const entered = gate(); const wait = gate(); const read = chain.customer.bind(chain);
  chain.customer = async c => { const snapshot = await read(c); entered.release(); await wait.promise; return readBeforeCharge ? snapshot : read(c); };
  now += 30_001;
  const refresh = charger.refreshAll(); await entered.promise;
  const charged = gate(); const charge = chain.charge.bind(chain);
  chain.charge = async items => { const out = await charge(items); charged.release(); return out; };
  const flushing = charger.flush(); await charged.promise;
  wait.release(); await Promise.all([refresh, flushing]);
  const room = charger.available('alice.test')!;
  assert.ok(room.balance <= 1_000_000n - fake.price);
  assert.equal((await charger.admit('alice.test', 1_000_000n, () => ({ id: 'b', receiptsRoot: sha256Hex('s') }))).ok, false);
  chain.customer = read; now += 30_001; await charger.refreshAll();
  assert.equal(charger.available('alice.test')!.balance, 1_000_000n - fake.price);
});

test('known duplicate sequence is not reserved as a fresh charge', async () => {
  const { fake, chain } = await setup();
  fake.applyCharge(fake.workerKey!, [{ customer: 'alice.test', seq: 1, units: 1, receipts_root: sha256Hex('old') }]);
  const charger = new Charger(chain, hooks);
  charger.restore('alice.test', { pending: [{ id: 'old', customer: 'alice.test', seq: 1, cost: fake.price, receiptsRoot: sha256Hex('old'), retries: 0 }] });
  await charger.floorOf('alice.test'); await charger.flush();
  assert.equal(charger.available('alice.test')!.balance, 1_000_000n - fake.price);
  assert.equal(fake.revenue, fake.price);
});

test('duplicate after ambiguous confirmation stays reserved until its sequence is visible', async () => {
  const { fake, chain } = await setup(); const stale = fake.customerView('alice.test');
  chain.customer = async () => stale;
  const charge = chain.charge.bind(chain); let first = true;
  chain.charge = async items => { const out = await charge(items); if (first) { first = false; throw new Error('lost response'); } return out; };
  let now = 0;
  const charger = new Charger(chain, hooks, () => now);
  await charger.admit('alice.test', fake.price, () => ({ id: 'a', receiptsRoot: sha256Hex('r') }));
  await charger.flush(); await charger.flush();
  assert.equal(charger.available('alice.test')!.balance, 0n, 'unknown original debit requires a fresh inclusive ledger');
  assert.equal(fake.revenue, fake.price);
  chain.customer = async () => fake.customerView('alice.test');
  now = 31_000;
  assert.equal((await charger.admit('alice.test', 1n, () => ({ id: 'b', receiptsRoot: sha256Hex('b') }))).ok, true);
  assert.equal(charger.available('alice.test')!.balance, 1_000_000n - fake.price - 1n);
});

test('charger submits the admitted quote through retry and restore', async () => {
  const { chain } = await setup();
  const seen: unknown[] = [];
  chain.charge = async items => { seen.push(items[0]); return { ok: false, results: [] }; };
  const charger = new Charger(chain, hooks);
  charger.restore('alice.test', { pending: [{ id: 'old', customer: 'alice.test', seq: 1, cost: 123n, receiptsRoot: sha256Hex('old'), retries: 0 }] });
  await charger.flush(); await charger.flush();
  assert.equal((seen[0] as { quoted_price?: string }).quoted_price, '123');
  assert.deepEqual(seen[1], seen[0]);
});

test('v2 price uses effective view without future-price lookahead', async () => {
  const { fake, worker } = await setup();
  const info = await fake.as(fake.workerKey!).info();
  Object.assign(info, { protocol_version: 2, price_per_call: '100', pending_price: '300', price_effective_at_ms: String(Date.now() + 60_000) });
  const internal = worker as unknown as { info: typeof info; price(): bigint };
  internal.info = info;
  assert.equal(internal.price(),100n);
  worker.stop();
});

test('unpaid takeover preserves the original receipt quote at a different worker price', async () => {
  const { fake, signer, worker, request } = await setup();
  const accepted = await worker.deliver('alice.test', request);
  const original = (accepted.body as { receipt: ObligationEntry['receipt'] }).receipt;
  const receipt = signReceipt(signer, { ...original.payload, delivery_id: sha256Hex('takeover-price'), price: '123' });
  // Exercise validated handover after signature/request verification: price is the invariant here.
  const internal = worker as unknown as { takeOverValidated(e: ObligationEntry, c: string | null, r: typeof request): Promise<{ receipt: typeof receipt }> };
  const result = await internal.takeOverValidated({ receipt, attempts: [] } as unknown as ObligationEntry, 'alice.test', request);
  assert.equal(result.receipt.payload.price, '123');
  worker.stop();
});

test('RPC adapter fails closed for missing or zero v2 quotes and permits legacy items', async () => {
  const { Rpc } = await import('@outlive/sdk');
  const { RpcVaultChain } = await import('../src/vault-chain.js');
  const chain = new RpcVaultChain('v.test', new Rpc(['http://localhost:1']), generateSecretKey().secretKey, 50);
  let version: number | undefined = 2;
  let calls = 0;
  const internal = chain as unknown as { views: { info(): Promise<unknown> }; signer: { call(): Promise<unknown> } };
  internal.views.info = async () => ({ protocol_version: version });
  internal.signer.call = async () => { calls++; return { success: true, value: [] }; };
  const item = { customer: 'alice.test', seq: 1, units: 1, receipts_root: sha256Hex('quote') };
  assert.equal((await chain.charge([item])).ok,false);
  assert.equal((await chain.charge([{ ...item, quoted_price: '0' }])).ok,false);
  assert.equal(calls,0);
  assert.equal((await chain.charge([{ ...item, quoted_price: '123' }])).ok,true);
  version = undefined;
  await chain.info();
  assert.equal((await chain.charge([item])).ok,true);
  assert.equal(calls,2);
});

test('resequence preserves the quote and reserves its exact cost', async () => {
  const { chain } = await setup();
  const snapshot = (await chain.customer('alice.test'))!;
  let sends = 0;
  const quotes: string[] = [];
  chain.customer = async () => ({ ...snapshot, last_seq: sends ? '5' : '0' });
  chain.charge = async items => {
    sends++;
    quotes.push(items[0]!.quoted_price!);
    return { ok: true, results: items.map(i => ({ customer: i.customer, seq: i.seq, status: sends === 1 ? 'seq_gap' : 'charged', cost: sends === 1 ? '0' : '123' })) };
  };
  let reissued: PendingCharge | undefined;
  const charger = new Charger(chain, { ...hooks, onReseq: i => { reissued = { ...i }; return i.receiptsRoot; } });
  charger.restore('alice.test', { pending: [{ id: 'old', customer: 'alice.test', seq: 2, cost: 123n, receiptsRoot: sha256Hex('old'), retries: 0 }] });
  await charger.flush();
  assert.equal(reissued?.seq, 6); assert.equal(reissued?.cost, 123n);
  await charger.flush();
  assert.deepEqual(quotes, ['123','123']);
  assert.equal(charger.available('alice.test')!.balance,999_877n);
});

// Rotated-out key policy: a hand-off may carry only work already charged on chain.
// Anything uncharged must come from the customer, or a revoked worker key could keep
// minting new billable obligations through its successor after revocation.
async function rotatedSetup() {
  const old = await setup();
  const signer = signerFromSecretKey(generateSecretKey().secretKey);
  old.fake.setWorker(signer.publicKey);
  const chain = old.fake.as(signer.publicKey);
  const worker = new Worker({ vault: old.fake.vault, network: 'testnet', chain, signer, journalFile: null, publicUrl: 'http://localhost:2', allowTarget: '127.0.0.1:7620', handoff: false, log: () => {} });
  await worker.checkKey();
  return { ...old, worker };
}
function forged(old: Awaited<ReturnType<typeof setup>>, id: string, over: Partial<{ seq: number; price: string; url: string }> = {}): ObligationEntry {
  const request = { ...old.request, url: over.url ?? old.request.url, idempotency_key: id };
  const receipt = signReceipt(old.signer, {
    receipt_version: 2, request_sha256: requestHash(request), delivery_id: `d_${sha256Hex(id).slice(0, 24)}`,
    vault: old.fake.vault, customer: 'alice.test', seq: over.seq ?? 1, price: over.price ?? '10000',
    target_url_sha256: sha256Hex(request.url), body_sha256: sha256Hex(request.body),
    accepted_at: Date.now(), worker_public_key: old.signer.publicKey,
  });
  return { request, receipt };
}
test('a revoked worker key cannot charge new obligations through handoff', async () => {
  const old = await rotatedSetup();
  const entry = forged(old, 'revoked-new-1');
  const handoff = await old.worker.acceptHandoff(signDocument(HANDOFF_DOMAIN, old.signer, { vault: old.fake.vault, from_public_key: old.signer.publicKey, created_at: Date.now(), entries: [entry] }));
  const result = (handoff.body as { results: { result: string; reason?: string }[] }).results[0]!;
  assert.equal(result.result, 'rejected');
  assert.match(result.reason!, /customer presentation/);
  await old.worker.flushCharges();
  assert.equal(old.fake.revenue, 0n);
  assert.equal(old.fake.charges.length, 0);
});
test('handoff still delivers work already charged on chain, without charging again', async () => {
  const old = await rotatedSetup();
  const settled = forged(old, 'settled-1');
  const presented = await old.worker.acceptObligations('alice.test', { entries: [settled] });
  assert.equal((presented.body as { results: { result: string }[] }).results[0]!.result, 'accepted');
  await old.worker.flushCharges();
  assert.equal(old.fake.revenue, 10000n);
  const later = forged(old, 'settled-2', { seq: 1 });
  const handoff = await old.worker.acceptHandoff(signDocument(HANDOFF_DOMAIN, old.signer, { vault: old.fake.vault, from_public_key: old.signer.publicKey, created_at: Date.now(), entries: [later] }));
  const result = (handoff.body as { results: { result: string; charged_as_new?: boolean }[] }).results[0]!;
  assert.equal(result.result, 'accepted');
  assert.equal(result.charged_as_new, false);
  assert.equal(old.fake.revenue, 10000n);
});
test('customer presentation still charges an uncharged obligation after revocation', async () => {
  const old = await rotatedSetup();
  const entry = forged(old, 'recovery-1');
  const reply = await old.worker.acceptObligations('alice.test', { entries: [entry] });
  assert.equal((reply.body as { results: { result: string; charged_as_new?: boolean }[] }).results[0]!.charged_as_new, true);
  await old.worker.flushCharges();
  assert.equal(old.fake.revenue, 10000n);
});
test('takeover rejects a non-positive or malformed receipt price', async () => {
  const old = await rotatedSetup();
  for (const price of ['0', '-5', '1e3']) {
    const reply = await old.worker.acceptObligations('alice.test', { entries: [forged(old, `price-${price}`, { price })] });
    const result = (reply.body as { results: { result: string; reason?: string }[] }).results[0]!;
    assert.equal(result.result, 'rejected', price);
    assert.match(result.reason!, /bad price/, price);
  }
  await old.worker.flushCharges();
  assert.equal(old.fake.revenue, 0n);
});
test('takeover checks the target before reserving or charging anything', async () => {
  const old = await rotatedSetup();
  const entry = forged(old, 'ssrf-1', { url: 'http://169.254.169.254/latest/meta-data' });
  const reply = await old.worker.acceptObligations('alice.test', { entries: [entry] });
  const result = (reply.body as { results: { result: string; reason?: string }[] }).results[0]!;
  assert.equal(result.result, 'rejected');
  assert.match(result.reason!, /target refused/);
  await old.worker.flushCharges();
  assert.equal(old.fake.revenue, 0n);
});
test('renumber never reuses sequences confirmed inside the same worker', async () => {
  const { chain } = await setup();
  const snapshot = (await chain.customer('alice.test'))!;
  const batches: number[][] = [];
  let sends = 0;
  // A lagging view: nothing ever appears confirmed, so confirmed items live in `unseen`.
  chain.customer = async () => ({ ...snapshot, last_seq: '0' });
  chain.charge = async (items: { customer: string; seq: number }[]) => {
    sends += 1;
    batches.push(items.map(i => i.seq));
    return { ok: true, results: items.map((i, idx) => ({ customer: i.customer, seq: i.seq, status: sends === 1 && idx === 1 ? 'seq_gap' : 'charged', cost: '123' })) };
  };
  const reseqs: number[] = [];
  const charger = new Charger(chain, { ...hooks, onReseq: i => { reseqs.push(i.seq); return i.receiptsRoot; } });
  await charger.admit('alice.test', 123n, () => ({ id: 'a', receiptsRoot: sha256Hex('a') }));
  charger.restore('alice.test', { pending: [{ id: 'x', customer: 'alice.test', seq: 5, cost: 123n, receiptsRoot: sha256Hex('x'), retries: 0 }] });
  await charger.flush();
  await charger.flush();
  assert.deepEqual(reseqs, [2], 'seq 1 is already used by the confirmed-in-unseen item; the gap renumbers to 2');
  assert.ok(!batches[1]!.includes(1), 'no batch may resend a sequence this worker already used');
});
