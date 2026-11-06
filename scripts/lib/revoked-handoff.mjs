import assert from 'node:assert/strict';
import { HANDOFF_DOMAIN, requestHash, sha256Hex, signDocument, signProof, signReceipt } from '../../sdk/dist/src/index.js';

export const POLICY_REASON = 'uncharged obligation requires customer presentation';

export function singleResult(reply, id) {
  assert.equal(reply.status, 200, 'successor must process the envelope, not reject its syntax/auth');
  assert.ok(Array.isArray(reply.body?.results), 'missing obligation results');
  assert.equal(reply.body.results.length, 1, 'expected exactly one obligation result');
  assert.equal(reply.body.results[0].delivery_id, id, 'result is not for the attack delivery');
  return reply.body.results[0];
}

export function assertPolicyRefusal(reply, id) {
  const result = singleResult(reply, id);
  assert.equal(result.result, 'rejected', 'successor accepted or already knew uncharged handoff');
  assert.equal(result.reason, POLICY_REASON, 'refusal was not the protocol-v2 uncharged-handoff policy');
  assert.notEqual(result.charged_as_new, true, 'refusal unexpectedly allocated a charge');
}

export function ledgerSnapshot(customer, info) {
  assert.ok(customer, 'customer must already have deposited credit');
  const result = {
    last_seq: customer.last_seq, balance: customer.balance, revenue: info.revenue,
    charged_items: info.charged_items, liabilities: info.liabilities,
  };
  for (const [field, value] of Object.entries(result)) {
    assert.equal(typeof value, 'string', `${field} must be an integer string`);
    assert.match(value, /^(0|[1-9][0-9]*)$/, `${field} must be an unsigned integer`);
  }
  return result;
}

export function assertUnchanged(before, after) {
  for (const field of Object.keys(before)) assert.equal(after[field], before[field], `${field} changed without customer authorization`);
}

export function assertOneCharge(before, after, price) {
  const expected = {
    last_seq: BigInt(before.last_seq) + 1n, balance: BigInt(before.balance) - BigInt(price),
    revenue: BigInt(before.revenue) + BigInt(price), charged_items: BigInt(before.charged_items) + 1n,
    liabilities: BigInt(before.liabilities) - BigInt(price),
  };
  for (const [field, value] of Object.entries(expected)) assert.equal(after[field], String(value), `positive control ${field}: expected exactly one quoted debit`);
}

export function buildAttack({ vault, customer, lastSeq, price, target, signer, now, nonce }) {
  assert.match(nonce, /^[0-9a-f]{24}$/, 'nonce must be 12 random bytes in hex');
  assert.match(price, /^[1-9][0-9]*$/, 'quote must be a positive integer');
  assert.match(String(lastSeq), /^(0|[1-9][0-9]*)$/, 'last_seq must be an integer');
  const seq = Number(BigInt(lastSeq) + 1n);
  assert.ok(Number.isSafeInteger(seq), 'next sequence exceeds the worker safe integer range');
  const url = new URL(target);
  assert.ok(['http:', 'https:'].includes(url.protocol), 'target must use HTTP(S)');
  assert.ok(!url.username && !url.password && !url.hash, 'target must not contain credentials or a fragment');
  const id = `d_${nonce}`;
  const request = {
    url: url.href, method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ check: 'revoked-handoff', nonce }), idempotency_key: `revoked-handoff-${nonce}`,
  };
  const receipt = signReceipt(signer, {
    receipt_version: 2, request_sha256: requestHash(request), delivery_id: id, vault, customer, seq, price,
    target_url_sha256: sha256Hex(request.url), body_sha256: sha256Hex(request.body), accepted_at: now,
    worker_public_key: signer.publicKey,
  });
  // This proof is intentionally forged by the revoked key, not evidence of a real HTTP call.
  // Even a valid 2xx proof must not turn uncharged work into successor billing authority.
  const proof = signProof(signer, {
    delivery_id: id, vault, attempt: 1, status_code: 200, response_sha256: sha256Hex('forged response'),
    at: now, worker_public_key: signer.publicKey,
  });
  const entry = { request, receipt, attempts: [proof] };
  const envelope = signDocument(HANDOFF_DOMAIN, signer, {
    vault, from_public_key: signer.publicKey, created_at: now, entries: [entry],
  });
  return { entry, envelope };
}
