import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair, KeyPairSigner } from "near-api-js";

import {
  authMessage,
  canonicalJson,
  formatUnits,
  fromBase64,
  fromUnits,
  generateSecretKey,
  parseAuthHeaders,
  payback,
  sha256Hex,
  signerFromSecretKey,
  signOutbound,
  signPayload,
  signProof,
  signReceipt,
  signRequest,
  verifyOutbound,
  verifyPayload,
  verifyProof,
  verifyReceipt,
  windowDays,
  type ObligationReceipt,
} from "../src/index.js";

const VAULT = "relay.outlive.testnet";

function receipt(publicKey: string): ObligationReceipt {
  return {
    delivery_id: "d_1",
    vault: VAULT,
    customer: "alice.testnet",
    seq: 7,
    price: "10000",
    target_url_sha256: sha256Hex("https://example.com/hook"),
    body_sha256: sha256Hex("{}"),
    accepted_at: 1_700_000_000_000,
    worker_public_key: publicKey,
  };
}

test("canonical JSON sorts keys at every level and drops undefined", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: "x" }, u: undefined }), '{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
});

test("units round trip", () => {
  assert.equal(fromUnits("1.5", 6), 1_500_000n);
  assert.equal(fromUnits("20", 6), 20_000_000n);
  assert.equal(formatUnits(1_500_000n, 6), "1.5");
  assert.equal(formatUnits("10000", 6), "0.01");
  assert.equal(formatUnits(0n, 6), "0");
  assert.throws(() => fromUnits("0.0000001", 6));
  assert.throws(() => fromUnits("-1", 6));
});

test("signer from a NEAR secret key matches near-api-js", () => {
  const kp = KeyPair.fromRandom("ed25519");
  const signer = signerFromSecretKey(kp.toString());
  assert.equal(signer.publicKey, kp.getPublicKey().toString());
  const msg = new TextEncoder().encode("hello");
  const ours = signer.sign(msg);
  assert.ok(kp.verify(msg, ours));
});

test("generated keys are valid NEAR keys", () => {
  const { secretKey, publicKey } = generateSecretKey();
  const kp = KeyPair.fromString(secretKey as `ed25519:${string}`);
  assert.equal(kp.getPublicKey().toString(), publicKey);
});

test("NEP-413 serialization matches near-api-js signNep413Message", async () => {
  const kp = KeyPair.fromRandom("ed25519");
  const nonce = new Uint8Array(32).fill(7);
  const payload = { message: authMessage("POST", "/v1/deliveries", sha256Hex("x"), 123), nonce, recipient: VAULT };
  const theirs = await new KeyPairSigner(kp).signNep413Message("alice.testnet", payload);
  const ours = signPayload(signerFromSecretKey(kp.toString()), payload);
  assert.deepEqual(Buffer.from(ours), Buffer.from(theirs.signature));
  assert.ok(verifyPayload(kp.getPublicKey().toString(), payload, theirs.signature));
  assert.ok(!verifyPayload(kp.getPublicKey().toString(), { ...payload, recipient: "other.testnet" }, theirs.signature));
});

test("signed request headers parse and verify", () => {
  const { secretKey } = generateSecretKey();
  const signer = signerFromSecretKey(secretKey);
  const headers = signRequest({ accountId: "alice.testnet", signer, vault: VAULT, method: "POST", path: "/v1/deliveries", body: "{}", now: 1000 });
  const parsed = parseAuthHeaders(headers);
  assert.ok(typeof parsed !== "string");
  const message = authMessage("POST", "/v1/deliveries", sha256Hex("{}"), parsed.timestamp);
  assert.ok(verifyPayload(parsed.publicKey, { message, nonce: parsed.nonce, recipient: VAULT }, parsed.signature));
  const tampered = authMessage("POST", "/v1/deliveries", sha256Hex("{ }"), parsed.timestamp);
  assert.ok(!verifyPayload(parsed.publicKey, { message: tampered, nonce: parsed.nonce, recipient: VAULT }, parsed.signature));
  assert.equal(parseAuthHeaders({}), "missing NEP-413 auth headers");
});

test("receipts and proofs verify and reject tampering and domain reuse", () => {
  const { secretKey, publicKey } = generateSecretKey();
  const signer = signerFromSecretKey(secretKey);
  const doc = signReceipt(signer, receipt(publicKey));
  assert.ok(verifyReceipt(doc));
  assert.ok(!verifyReceipt({ ...doc, payload: { ...doc.payload, seq: 8 } }));
  const other = generateSecretKey();
  assert.ok(!verifyReceipt({ ...doc, payload: { ...doc.payload, worker_public_key: other.publicKey } }));
  assert.throws(() => signReceipt(signer, receipt(other.publicKey)));

  const proof = signProof(signer, {
    delivery_id: "d_1",
    vault: VAULT,
    attempt: 1,
    status_code: 200,
    response_sha256: sha256Hex("ok"),
    at: 1,
    worker_public_key: publicKey,
  });
  assert.ok(verifyProof(proof));
  // A receipt signature is not a valid proof signature and the other way round.
  assert.ok(!verifyProof({ payload: proof.payload, signature: doc.signature }));
  assert.ok(!verifyReceipt({ payload: doc.payload, signature: proof.signature }));
  assert.equal(fromBase64(doc.signature).length, 64);
});

test("outbound relay signature verifies on the target side", () => {
  const { secretKey, publicKey } = generateSecretKey();
  const signer = signerFromSecretKey(secretKey);
  const fields = { vault: VAULT, deliveryId: "d_1", attempt: 2, timestamp: 5, method: "post", path: "/hook?x=1", bodySha256: sha256Hex("{}") };
  const headers = signOutbound(signer, fields);
  const ok = verifyOutbound(headers, { method: "POST", path: "/hook?x=1", bodySha256: sha256Hex("{}") });
  assert.deepEqual(ok, { ok: true, vault: VAULT, key: publicKey, deliveryId: "d_1" });
  assert.equal(verifyOutbound(headers, { method: "POST", path: "/hook", bodySha256: sha256Hex("{}") }).ok, false);
  assert.equal(verifyOutbound({}, { method: "POST", path: "/", bodySha256: "" }).ok, false);
});

test("payback uses the vault age as the window, between 1 and 30 days", () => {
  const day = 86_400_000;
  assert.equal(windowDays(0, 10 * 60_000), 1);
  assert.equal(windowDays(0, 12 * day), 12);
  assert.equal(windowDays(0, 90 * day), 30);

  const r = payback({
    price: 20_000_000n,
    cash: 2_000_000n,
    revenue30d: 30_000_000n,
    gasSpent30dYocto: 10n ** 24n, // 1 NEAR over 10 days
    vaultCreatedAtMs: 0,
    nowMs: 10 * day,
    nearPrice: 3,
    tokenDecimals: 6,
  });
  assert.equal(r.windowDays, 10);
  assert.equal(r.revenuePerDay, 3);
  assert.ok(Math.abs(r.gasPerDay - 0.3) < 1e-9);
  assert.equal(r.netPrice, 18);
  assert.ok(Math.abs((r.paybackDays ?? 0) - 18 / 2.7) < 1e-9);

  const never = payback({ price: 1n, cash: 0n, revenue30d: 0n, gasSpent30dYocto: 0n, vaultCreatedAtMs: 0, nowMs: day, nearPrice: 3, tokenDecimals: 6 });
  assert.equal(never.paybackDays, null);
  const free = payback({ price: 1n, cash: 5n, revenue30d: 1n, gasSpent30dYocto: 0n, vaultCreatedAtMs: 0, nowMs: day, nearPrice: 3, tokenDecimals: 6 });
  assert.equal(free.netPrice, 0);
  assert.equal(free.paybackDays, 0);
});
