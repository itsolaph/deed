#!/usr/bin/env node
// Adversarial check against an EXISTING isolated protocol-v2 testnet vault.
// No mint, funding, rotation, deployment, or direct transaction submission here.
// --execute authorizes the successor to bill ONE call in the customer positive control.
// Without it, --check-only performs public views/file-existence checks; no key is loaded.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  Rpc, HANDOFF_DOMAIN, receiptMatchesRequest, signRequest, signerFromSecretKey,
  verifyDocument, verifyProof, verifyReceipt, verifySignature,
} from '../sdk/dist/src/index.js';
import { readKeyFile } from '../sdk/dist/src/node.js';
import { assertOneCharge, assertPolicyRefusal, assertUnchanged, buildAttack, ledgerSnapshot, singleResult } from './lib/revoked-handoff.mjs';

export const V2_CODE_HASH = 'DJH3FB9GvLK4fh3qx4pThyvoXxJB7tmWe8FCEBKNk1RZ';
const LIVE_VAULT = 'relay-live.outlive3.outlive.testnet';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const USAGE = `Usage: node scripts/verify-revoked-handoff.mjs \\
  --vault <existing.outlive3.outlive.testnet> --customer <account.testnet> \\
  --endpoint <successor-origin> --target <controlled-webhook-url> \\
  --key-file <current-worker.json> --revoked-key-file <previous-worker.json> \\
  --customer-key-file <customer.json> (--check-only | --execute)

--check-only    Public RPC + worker health + key-path existence only; NEVER loads keys.
--execute       Sign with the supplied files using the existing SDK key loader; send a
                forged handoff, then NEP-413 customer presentation (ONE paid call).
--price        Required quoted price in micro-tUSDC (default 10000).
--observe-ms   Unchanged-ledger observation per phase (default 12000, minimum 8000).
               Set to at least twice the successor's configured --flush-ms.
--timeout-ms   Positive settlement/delivery deadline (default 180000).
--poll-ms      Ledger polling interval (default 2000).

Build SDK/worker/agents first: npm run build
Stop all traffic/withdrawals/deposits for this vault; use a fresh successor journal.
The target must return 2xx and be allowed by the successor's SSRF policy. A local
controlled target requires --allow-target <host:port> on that worker.
Never run against ${LIVE_VAULT} (hard refused).
Output: one JSON summary, exit 0 only for the requested mode's verified outcome.
A check-only success is NOT an adversarial testnet proof. No key material is output.
`;

async function httpJson(endpoint, route, { body, headers = {}, timeoutMs = 90000 } = {}) {
  const res = await fetch(`${endpoint}${route}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body }), signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed;
  try { parsed = await res.json(); } catch { throw new Error(`${route} returned non-JSON HTTP ${res.status}`); }
  return { status: res.status, body: parsed };
}

// Pin both financial views to ONE finalized block; separate moving-head views can
// otherwise look like a partial debit. Public RPC reads only.
async function readState(rpc, opts) {
  const { header } = await rpc.request('block', { finality: 'final' });
  const at = async (method, args) => {
    const result = await rpc.request('query', {
      request_type: 'call_function', account_id: opts.vault, block_id: header.hash,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    });
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
  };
  const [info, customer] = await Promise.all([
    at('get_info', {}), at('get_customer', { account_id: opts.customer }),
  ]);
  return { block_hash: header.hash, block_height: header.height, info, customer, ledger: ledgerSnapshot(customer, info) };
}

function assertConfig(info, opts, key) {
  assert.equal(info.protocol_version, 2, 'vault must advertise protocol_version 2');
  assert.equal(info.payment_token, 'tusdc.outlive.testnet', 'wrong testnet payment token');
  assert.equal(info.price_per_call, opts.price, 'vault price differs from the explicit quote');
  assert.equal(info.pending_price, null, 'pending price change: isolate this test first');
  assert.equal(info.worker_rotation_pending, null, 'worker rotation is not settled');
  assert.equal(info.worker_key, key, 'registered worker changed during verification');
  assert.equal(info.endpoint.replace(/\/+$/, ''), opts.endpoint, 'successor must be the endpoint published by this vault');
  assert.equal(info.locked, false, 'vault must not be locked');
  assert.equal(info.in_flight, '0', 'vault has a pending withdrawal');
}

function assertHealth(reply, opts, key) {
  assert.equal(reply.status, 200, 'successor is not healthy');
  const h = reply.body;
  assert.equal(h.ok, true);
  assert.equal(h.accepting, true, 'successor is retired');
  assert.equal(h.vault, opts.vault, 'successor serves another vault');
  assert.equal(h.worker_public_key, key, 'successor has another signing key');
  assert.equal(h.price_per_call, opts.price);
  assert.equal(h.payment_token, 'tusdc.outlive.testnet');
  assert.equal(h.queue?.pending, 0, 'successor has pending work: isolate this test first');
  return h;
}

export async function runVerification(opts, { rpc, signers, summary }) {
  assert.notEqual(opts.vault, LIVE_VAULT, 'the live relay is explicitly out of scope');
  assert.match(opts.vault, /^[a-z0-9_-]+\.outlive3\.outlive\.testnet$/, 'use an existing v2 factory testnet vault');
  assert.match(opts.customer, /^[a-z0-9_.-]+\.testnet$/, 'customer must be a testnet account');
  summary.stage = 'public_preflight';
  const initial = await readState(rpc, opts);
  const currentKey = initial.info.worker_key;
  assert.ok(currentKey, 'vault has no registered worker');
  assertConfig(initial.info, opts, currentKey);
  const [account, keys, history, customerKeys] = await Promise.all([
    rpc.account(opts.vault), rpc.accessKeys(opts.vault),
    rpc.view(opts.vault, 'get_worker_history'), rpc.accessKeys(opts.customer),
  ]);
  assert.equal(account.code_hash, V2_CODE_HASH, 'deployed vault code is not the verified v2 build');
  const permission = keys.find((k) => k.public_key === currentKey)?.access_key.permission?.FunctionCall;
  assert.ok(permission, 'current worker lacks a function-call access key');
  assert.equal(permission.receiver_id, opts.vault);
  assert.deepEqual(permission.method_names, ['charge'], 'worker key must be restricted to charge');
  assert.ok(permission.allowance === null || BigInt(permission.allowance) > 0n, 'worker allowance is exhausted');
  assert.equal(initial.customer.refund_requested_at_ms, null, 'customer refund is pending');
  assert.ok(BigInt(initial.customer.balance) >= BigInt(opts.price), 'customer lacks deposited credit');
  assert.ok(BigInt(initial.customer.chargeable_today) >= BigInt(opts.price), 'customer daily cap has no room');
  summary.prerequisites = {
    code_hash: account.code_hash, protocol_version: initial.info.protocol_version,
    current_worker_key: currentKey, worker_history: history, worker_allowance: permission.allowance,
    vault_near_yocto: account.amount, ledger: initial.ledger,
    block_hash: initial.block_hash, block_height: initial.block_height,
  };
  summary.stage = 'successor_health';
  assertHealth(await httpJson(opts.endpoint, '/v1/health'), opts, currentKey);
  summary.prerequisites.successor_healthy = true;
  if (opts.checkOnly) {
    summary.proof_executed = false;
    summary.warning = 'Public prerequisites only; key contents, signatures, handoff refusal and real settlement remain untested.';
    return;
  }

  summary.stage = 'signer_preflight';
  // CLI supplies opaque SDK Signer objects. The test runner can supply ephemeral
  // in-memory signers; no test or read-only mode opens a credential file.
  const { current, revoked, customer } = signers ?? await loadSigners(opts);
  assert.equal(current.publicKey, currentKey, '--key-file does not hold the registered worker');
  assert.notEqual(revoked.publicKey, currentKey, 'revoked and current keys must differ');
  assert.ok(history.some((k) => k.public_key === revoked.publicKey), 'revoked key is not in this vault history');
  assert.ok(!keys.some((k) => k.public_key === revoked.publicKey), 'previous key is NOT revoked on chain');
  assert.ok(customerKeys.some((k) => k.public_key === customer.publicKey && k.access_key.permission === 'FullAccess'), 'customer signer must be its own on-chain full-access key');
  const challenge = randomBytes(32);
  assert.ok(verifySignature(currentKey, challenge, current.sign(challenge)), 'current key cannot sign');
  summary.prerequisites.revoked_worker_key = revoked.publicKey;
  summary.prerequisites.customer_public_key = customer.publicKey;
  const auth = async (route, payload) => {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    return httpJson(opts.endpoint, route, {
      ...(payload === undefined ? {} : { body }),
      headers: signRequest({ accountId: opts.customer, signer: customer, vault: opts.vault, method: payload === undefined ? 'GET' : 'POST', path: route, body }),
    });
  };
  const observe = async (expected) => {
    const deadline = Date.now() + opts.observeMs;
    let state;
    do {
      state = await readState(rpc, opts);
      assertConfig(state.info, opts, currentKey);
      assertUnchanged(expected, state.ledger);
      if (Date.now() >= deadline) return state;
      await sleep(Math.min(opts.pollMs, deadline - Date.now()));
    } while (true);
  };

  summary.stage = 'quiescent_baseline';
  const before = await observe(initial.ledger);
  summary.before = { ...before.ledger, block_hash: before.block_hash, block_height: before.block_height };
  const attack = buildAttack({
    vault: opts.vault, customer: opts.customer, lastSeq: before.ledger.last_seq, price: opts.price,
    target: opts.target, signer: revoked, now: Date.now(), nonce: randomBytes(12).toString('hex'),
  });
  const id = attack.entry.receipt.payload.delivery_id;
  assert.ok(verifyReceipt(attack.entry.receipt));
  assert.ok(verifyProof(attack.entry.attempts[0]));
  assert.ok(verifyDocument(HANDOFF_DOMAIN, attack.envelope, revoked.publicKey));
  assert.ok(receiptMatchesRequest(attack.entry.receipt.payload, attack.entry.request));
  summary.attack = {
    delivery_id: id, uncharged_seq: attack.entry.receipt.payload.seq,
    cryptographic_signatures_valid: true, forged_after_revocation: true,
    signed_handoff: attack.envelope,
    note: 'The revoked key fabricated this receipt and 2xx proof; no predecessor HTTP delivery is claimed.',
  };
  summary.stage = 'attack_handoff';
  let response;
  // Always re-read the exact on-chain ledger even if HTTP processing throws.
  try {
    response = await httpJson(opts.endpoint, '/v1/handoff', { body: JSON.stringify(attack.envelope) });
    summary.attack.http_status = response.status;
    summary.attack.results = response.body?.results;
  } finally {
    const after = await readState(rpc, opts);
    summary.after_attack = { ...after.ledger, block_hash: after.block_hash, block_height: after.block_height };
    assertUnchanged(before.ledger, after.ledger);
  }
  assertPolicyRefusal(response, id);
  summary.stage = 'attack_unchanged_observation';
  await observe(before.ledger);
  assert.equal((await auth(`/v1/deliveries/${id}`)).status, 404, 'refused handoff nevertheless entered the successor journal');
  summary.attack.policy_refused = true;
  summary.attack.ledger_unchanged = true;

  summary.stage = 'customer_positive_control';
  // The SAME customer-bound receipt, now explicitly authorized by the customer's
  // own NEP-413 request. The handoff's fabricated delivery proofs are NOT presented.
  const presentation = { entries: [{ request: attack.entry.request, receipt: attack.entry.receipt }] };
  const accepted = singleResult(await auth('/v1/obligations', presentation), id);
  assert.equal(accepted.result, 'accepted', 'positive control was not accepted as new');
  assert.equal(accepted.charged_as_new, true, 'positive control was not newly billable');
  assert.ok(accepted.receipt && verifyReceipt(accepted.receipt), 'successor receipt signature is invalid');
  const receipt = accepted.receipt.payload;
  assert.equal(receipt.delivery_id, id);
  assert.equal(receipt.worker_public_key, currentKey);
  assert.equal(receipt.customer, opts.customer);
  assert.equal(receipt.vault, opts.vault);
  assert.equal(receipt.price, opts.price);
  assert.equal(String(receipt.seq), String(BigInt(before.ledger.last_seq) + 1n));
  assert.ok(receiptMatchesRequest(receipt, attack.entry.request));
  summary.positive_control = { accepted: true, successor_receipt: accepted.receipt };
  const deadline = Date.now() + opts.timeoutMs;
  let settled;
  let delivered;
  do {
    settled = await readState(rpc, opts);
    assertConfig(settled.info, opts, currentKey);
    if (settled.ledger.last_seq === before.ledger.last_seq) assertUnchanged(before.ledger, settled.ledger);
    else assertOneCharge(before.ledger, settled.ledger, opts.price);
    const status = await auth(`/v1/deliveries/${id}`);
    assert.equal(status.status, 200, 'customer cannot track its accepted obligation');
    const proof = status.body.attempts?.at(-1);
    delivered = status.body.state === 'delivered' && proof && verifyProof(proof)
      && proof.payload.vault === opts.vault && proof.payload.delivery_id === id
      && proof.payload.worker_public_key === currentKey && proof.payload.status_code >= 200 && proof.payload.status_code < 300;
    if (settled.ledger.last_seq !== before.ledger.last_seq && delivered) break;
    assert.ok(Date.now() < deadline, 'positive control did not settle AND deliver before the deadline');
    await sleep(opts.pollMs);
  } while (true);
  assertOneCharge(before.ledger, settled.ledger, opts.price);
  summary.positive_control.delivered_with_valid_successor_proof = true;
  summary.stage = 'customer_replay';
  const replay = singleResult(await auth('/v1/obligations', presentation), id);
  assert.equal(replay.result, 'known', 'same receipt presentation is not idempotent');
  assert.notEqual(replay.charged_as_new, true, 'replay allocated another charge');
  summary.positive_control.replay_result = replay.result;
  const final = await observe(settled.ledger);
  assertOneCharge(before.ledger, final.ledger, opts.price);
  assertHealth(await httpJson(opts.endpoint, '/v1/health'), opts, currentKey);
  summary.after_positive_control = { ...final.ledger, block_hash: final.block_hash, block_height: final.block_height };
  summary.positive_control.charged_exactly_once = true;
  summary.proof_executed = true;
  summary.observation_ms_per_phase = opts.observeMs;
}

async function loadSigners(opts) {
  // Existing SDK loader is the only credential reader; never fs.readFile, log,
  // serialize, persist, or copy a key file here. SDK parsing errors can quote file
  // text, so suppress their details. This path is never used by --check-only/tests.
  const load = (file) => {
    try {
      const key = readKeyFile(file);
      const signer = signerFromSecretKey(key.private_key);
      assert.equal(signer.publicKey, key.public_key);
      return signer;
    } catch { throw new Error('SDK could not load a consistent signer from a supplied key file (details suppressed)'); }
  };
  return { current: load(opts.keyFile), revoked: load(opts.revokedKeyFile), customer: load(opts.customerKeyFile) };
}

export async function main(argv = process.argv.slice(2)) {
  const summary = { check: 'revoked-worker-handoff', network: 'testnet', ok: false, proof_executed: false };
  try {
    const { values: v } = parseArgs({ args: argv, options: {
      vault: { type: 'string' }, customer: { type: 'string' }, endpoint: { type: 'string' }, target: { type: 'string' },
      'key-file': { type: 'string' }, 'revoked-key-file': { type: 'string' }, 'customer-key-file': { type: 'string' },
      'check-only': { type: 'boolean' }, execute: { type: 'boolean' }, help: { type: 'boolean' },
      price: { type: 'string', default: '10000' }, 'observe-ms': { type: 'string', default: '12000' },
      'timeout-ms': { type: 'string', default: '180000' }, 'poll-ms': { type: 'string', default: '2000' },
    } });
    if (v.help) { process.stdout.write(USAGE); return 0; }
    for (const name of ['vault', 'customer', 'endpoint', 'target', 'key-file', 'revoked-key-file', 'customer-key-file']) assert.ok(v[name], `missing --${name}`);
    assert.ok(Boolean(v['check-only']) !== Boolean(v.execute), 'select exactly one of --check-only or --execute (one paid customer call)');
    const endpoint = new URL(v.endpoint);
    assert.ok(['http:', 'https:'].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash && endpoint.pathname === '/', '--endpoint must be an HTTP(S) origin without credentials');
    assert.match(v.price, /^[1-9][0-9]*$/, '--price must be positive micro-tUSDC');
    const opts = {
      vault: v.vault, customer: v.customer, endpoint: endpoint.origin, target: v.target, price: v.price,
      keyFile: v['key-file'], revokedKeyFile: v['revoked-key-file'], customerKeyFile: v['customer-key-file'],
      checkOnly: Boolean(v['check-only']), observeMs: Number(v['observe-ms']), timeoutMs: Number(v['timeout-ms']), pollMs: Number(v['poll-ms']),
    };
    assert.notEqual(opts.vault, LIVE_VAULT, 'the live relay is explicitly out of scope');
    for (const field of ['observeMs', 'timeoutMs', 'pollMs']) assert.ok(Number.isSafeInteger(opts[field]) && opts[field] > 0 && opts[field] <= 3600000, `invalid ${field}`);
    assert.ok(opts.observeMs >= 8000, '--observe-ms must cover at least two default 4-second flush intervals');
    assert.ok(opts.pollMs <= opts.observeMs && opts.pollMs < opts.timeoutMs, 'poll interval exceeds observation/deadline');
    // Validate target syntax before any key loading or state-changing HTTP call.
    const target = new URL(opts.target);
    assert.ok(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && !target.hash && target.href.length <= 2048, 'invalid target URL');
    for (const file of [opts.keyFile, opts.revokedKeyFile, opts.customerKeyFile]) assert.ok(fs.statSync(file).isFile(), 'a supplied key path is not a regular file');
    summary.mode = opts.checkOnly ? 'check-only' : 'execute';
    summary.vault = opts.vault;
    summary.customer = opts.customer;
    summary.endpoint = opts.endpoint;
    const rpc = new Rpc(process.env.NEAR_RPC_URLS ? process.env.NEAR_RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
    await runVerification(opts, { rpc, summary });
    summary.ok = true;
    summary.stage = 'complete';
  } catch (e) {
    summary.error = e instanceof Error ? e.message : 'verification failed';
  }
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return summary.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
