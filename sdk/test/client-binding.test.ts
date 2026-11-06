import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OutliveClient, generateSecretKey, signerFromSecretKey, signReceipt, requestHash, sha256Hex } from '../src/index.js';
import type { VaultReader } from '../src/client.js';
const signer = signerFromSecretKey(generateSecretKey().secretKey);
const request = { url: 'https://example.com/hook', method: 'POST', headers: {}, body: '{}', idempotency_key: 'one' };
const payload = { receipt_version: 2 as const, request_sha256: requestHash(request), delivery_id: 'signed-id', vault: 'vault.test', customer: 'alice.test', seq: 1, price: '1', target_url_sha256: sha256Hex(request.url), body_sha256: sha256Hex(request.body), accepted_at: 1, worker_public_key: signer.publicKey };
function client(body: unknown) {
  return new OutliveClient({ vault: payload.vault, accountId: payload.customer, signer, endpoint: 'https://relay.test', views: { info: async () => ({ worker_key: signer.publicKey }), workerHistory: async () => [] } as unknown as VaultReader, fetchImpl: (async () => Response.json(body, { status: 200 })) as typeof fetch });
}
test('v2 accepted response must name the signed delivery', async () => {
  const c = client({ delivery_id: 'unsigned-id', receipt: signReceipt(signer, payload) });
  await assert.rejects(c.deliver(request), /delivery/);
  assert.equal(c.pendingCount(), 0);
});
for (const mutation of [{ delivery_id: 'other' }, { customer: 'bob.test' }, { vault: 'other.test' }]) test(`status rejects signed receipt substitution ${JSON.stringify(mutation)}`, async () => {
  const c = client({ delivery_id: payload.delivery_id, receipt: signReceipt(signer, { ...payload, ...mutation }), state: 'delivered', attempts: [], next_attempt_at: null });
  await assert.rejects(c.status(payload.delivery_id), /receipt|delivery/);
});
test('status response itself must name the requested delivery', async () => {
  await assert.rejects(client({ delivery_id: 'other', receipt: signReceipt(signer, payload), state: 'delivered', attempts: [], next_attempt_at: null }).status(payload.delivery_id), /delivery/);
});
test('matching signed v2 accepted and status receipts succeed', async () => {
  const body = { delivery_id: payload.delivery_id, receipt: signReceipt(signer, payload), state: 'pending', attempts: [], next_attempt_at: null };
  assert.equal((await client(body).deliver(request)).delivery_id, payload.delivery_id);
  assert.equal((await client(body).status(payload.delivery_id)).delivery_id, payload.delivery_id);
});
