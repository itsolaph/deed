import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSecretKey, signerFromSecretKey, verifyReceipt, verifyProof, verifyDocument, HANDOFF_DOMAIN, receiptMatchesRequest } from '../../sdk/dist/src/index.js';

test('ledger gates detect sequence, balance, revenue and aggregate charge drift without float arithmetic', async () => {
  const { ledgerSnapshot, assertUnchanged, assertOneCharge } = await import('../lib/revoked-handoff.mjs');
  const customer = { last_seq: '75', balance: '90071992547409930000' };
  const info = { revenue: '90071992547409930000', charged_items: '150', liabilities: customer.balance };
  const before = ledgerSnapshot(customer, info);
  assertUnchanged(before, { ...before });
  for (const field of Object.keys(before)) {
    const mutated = { ...before, [field]: String(BigInt(before[field]) + 1n) };
    assert.throws(() => assertUnchanged(before, mutated), undefined, field);
  }
  const after = { last_seq: '76', balance: '90071992547409920000', revenue: '90071992547409940000', charged_items: '151', liabilities: '90071992547409920000' };
  assertOneCharge(before, after, '10000');
  assert.throws(() => assertOneCharge(before, before, '10000'));
  for (const field of Object.keys(after)) {
    assert.throws(() => assertOneCharge(before, { ...after, [field]: String(BigInt(after[field]) + 1n) }, '10000'), undefined, field);
  }
  assert.throws(() => ledgerSnapshot(null, info));
  assert.throws(() => ledgerSnapshot({ ...customer, last_seq: '1.5' }, info));
});

test('full runner exercises the real HTTP worker with NEP-413, refusal, settlement and replay (simulated chain only)', async () => {
  const { runVerification, V2_CODE_HASH } = await import('../verify-revoked-handoff.mjs');
  const { FakeVault } = await import('../../worker/dist/test/fake-vault.js');
  const { Worker } = await import('../../worker/dist/src/worker.js');
  const { Authenticator } = await import('../../worker/dist/src/auth.js');
  const { createServer } = await import('../../worker/dist/src/server.js');
  const { default: http } = await import('node:http');
  const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let hits = 0;
  const target = http.createServer((req, res) => { hits++; req.resume(); res.end('ok'); });
  await listen(target);
  const old = signer(), current = signer(), customer = signer();
  const fake = new FakeVault();
  const vault = 'relay.outlive3.outlive.testnet';
  Object.defineProperty(fake, 'vault', { value: vault });
  fake.setWorker(old.publicKey);
  fake.setWorker(current.publicKey);
  fake.addCustomer('alice.testnet', customer.publicKey, 1000000n);
  const chain = fake.as(current.publicKey);
  const originalInfo = chain.info;
  chain.info = async () => ({ ...await originalInfo(), protocol_version: 2, payment_token: 'tusdc.outlive.testnet', worker_rotation_pending: null });
  const worker = new Worker({ vault, network: 'testnet', chain, signer: current, journalFile: null, publicUrl: '', allowTarget: `127.0.0.1:${target.address().port}`, flushIntervalMs: 30, watchIntervalMs: 60000, log: () => {} });
  const server = createServer(worker, new Authenticator(vault, chain));
  await listen(server);
  fake.endpoint = `http://127.0.0.1:${server.address().port}`;
  const rpc = {
    account: async () => ({ code_hash: V2_CODE_HASH, amount: '3000000000000000000000000' }),
    accessKeys: async (id) => id === vault ? [{ public_key: current.publicKey, access_key: { permission: { FunctionCall: { receiver_id: vault, method_names: ['charge'], allowance: '1000000000000000000000000' } } } }] : [{ public_key: customer.publicKey, access_key: { permission: 'FullAccess' } }],
    view: async (_, method) => method === 'get_worker_history' ? fake.history : chain.info(),
    request: async (method, params) => {
      if (method === 'block') return { header: { hash: 'local-test-block', height: 1 } };
      const value = params.method_name === 'get_info' ? await chain.info() : fake.customerView('alice.testnet');
      return { result: [...Buffer.from(JSON.stringify(value))] };
    },
  };
  await worker.start();
  const opts = { vault, customer: 'alice.testnet', endpoint: fake.endpoint, target: `http://127.0.0.1:${target.address().port}/hook`, price: '10000', observeMs: 90, timeoutMs: 4000, pollMs: 30 };
  const summary = {};
  try {
    const readonly = {};
    await runVerification({ ...opts, checkOnly: true }, { rpc, summary: readonly, signers: { get current() { throw new Error('read-only mode touched a signer'); } } });
    assert.equal(readonly.proof_executed, false);
    assert.equal(fake.revenue, 0n);
    assert.equal(hits, 0);
    await runVerification(opts, { rpc, signers: { current, revoked: old, customer }, summary });
    assert.equal(summary.attack.policy_refused, true);
    assert.equal(summary.positive_control.charged_exactly_once, true);
    assert.equal(fake.revenue, 10000n);
    assert.equal(fake.customers.get('alice.testnet').lastSeq, 1);
    assert.equal(hits, 1, 'forged delivered proof is not delivery evidence; only customer control sent HTTP');
    assert.equal(summary.positive_control.replay_result, 'known');
    // A valid refusal is NOT a pass when the successor can deliver but cannot settle.
    chain.charge = async () => ({ ok: false, results: [], error: 'simulated settlement outage' });
    const broken = {};
    await assert.rejects(runVerification({ ...opts, timeoutMs: 350 }, { rpc, signers: { current, revoked: old, customer }, summary: broken }), /did not settle AND deliver/);
    assert.equal(broken.attack.policy_refused, true);
    assert.notEqual(broken.positive_control.charged_exactly_once, true);
    assert.equal(fake.revenue, 10000n, 'broken positive control never pretends to have charged');
  } finally {
    worker.stop();
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => target.close(r))]);
  }
});

test('CLI requires explicit billing consent and refuses the live relay before touching key paths', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = new URL('../verify-revoked-handoff.mjs', import.meta.url);
  const base = ['--vault', 'relay-test.outlive3.outlive.testnet', '--customer', 'alice.testnet', '--endpoint', 'http://127.0.0.1:1', '--target', 'http://127.0.0.1:2/hook', '--key-file', '/not-a-key/current.json', '--revoked-key-file', '/not-a-key/old.json', '--customer-key-file', '/not-a-key/customer.json'];
  for (const mode of [[], ['--check-only', '--execute']]) {
    const result = spawnSync(process.execPath, [script.pathname, ...base, ...mode], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, false);
    assert.equal(json.proof_executed, false);
    assert.match(json.error, /select exactly one/);
    assert.equal(result.stderr, '');
  }
  const args = [...base];
  args[1] = 'relay-live.outlive3.outlive.testnet';
  const live = spawnSync(process.execPath, [script.pathname, ...args, '--execute'], { encoding: 'utf8' });
  assert.equal(live.status, 1);
  assert.match(JSON.parse(live.stdout).error, /live relay is explicitly out of scope/);
});

test('payload builder refuses zero quotes, invalid nonces and unsafe sequence numbers', async () => {
  const { buildAttack } = await import('../lib/revoked-handoff.mjs');
  const valid = { vault: 'relay.testnet', customer: 'alice.testnet', lastSeq: '75', price: '10000', target: 'http://127.0.0.1:7620/hook', signer: signer(), now: 1000, nonce: 'ab'.repeat(12) };
  for (const mutation of [{ price: '0' }, { price: '1.5' }, { lastSeq: '9007199254740991' }, { lastSeq: '-1' }, { nonce: 'oops' }, { target: 'file:///etc/passwd' }, { target: 'https://user:pass@example.org/' }]) {
    assert.throws(() => buildAttack({ ...valid, ...mutation }));
  }
});

// These keys exist only in memory; no test opens a credential file or calls testnet.
const signer = () => signerFromSecretKey(generateSecretKey().secretKey);

test('constructs request-bound v2 receipt, successful proof and handoff with real revoked-key signatures', async () => {
  const { buildAttack } = await import('../lib/revoked-handoff.mjs');
  const revoked = signer();
  const attack = buildAttack({ vault: 'relay.testnet', customer: 'alice.testnet', lastSeq: '75', price: '10000', target: 'http://127.0.0.1:7620/hook', signer: revoked, now: 1000, nonce: 'ab'.repeat(12) });
  const { entry, envelope } = attack;
  assert.equal(entry.receipt.payload.seq, 76);
  assert.equal(entry.receipt.payload.delivery_id, 'd_' + 'ab'.repeat(12));
  assert.equal(entry.receipt.payload.customer, 'alice.testnet');
  assert.equal(entry.receipt.payload.price, '10000');
  assert.equal(entry.receipt.payload.receipt_version, 2);
  assert.ok(verifyReceipt(entry.receipt));
  assert.ok(receiptMatchesRequest(entry.receipt.payload, entry.request));
  assert.ok(verifyProof(entry.attempts[0]));
  assert.equal(entry.attempts[0].payload.status_code, 200);
  assert.ok(verifyDocument(HANDOFF_DOMAIN, envelope, revoked.publicKey));
  assert.deepEqual(envelope.payload.entries, [entry]);
  assert.ok(!receiptMatchesRequest(entry.receipt.payload, { ...entry.request, body: 'tampered' }));
});

test('refusal gate accepts only the exact v2 policy rejection, never malformed or broken-worker responses', async () => {
  const { assertPolicyRefusal } = await import('../lib/revoked-handoff.mjs');
  const id = 'd_' + 'ab'.repeat(12);
  const reply = { status: 200, body: { results: [{ delivery_id: id, result: 'rejected', reason: 'uncharged obligation requires customer presentation' }] } };
  assertPolicyRefusal(reply, id);
  for (const bad of [
    { status: 401, body: { error: 'bad hand-off signature' } },
    { status: 400, body: { error: 'bad hand-off envelope' } },
    { status: 500, body: { error: 'internal error' } },
    { status: 200, body: { results: [{ delivery_id: id, result: 'accepted' }] } },
    { status: 200, body: { results: [{ delivery_id: id, result: 'known' }] } },
    { status: 200, body: { results: [{ ...reply.body.results[0], reason: 'target refused: loopback' }] } },
    { status: 200, body: { results: [{ ...reply.body.results[0], delivery_id: 'other' }] } },
    { status: 200, body: { results: [...reply.body.results, ...reply.body.results] } },
  ]) assert.throws(() => assertPolicyRefusal(bad, id));
});
