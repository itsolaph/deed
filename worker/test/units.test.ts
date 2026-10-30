import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSecretKey, sha256Hex, signerFromSecretKey, signRequest } from "@deed/sdk";

import { Authenticator } from "../src/auth.js";
import { Charger, type PendingCharge } from "../src/charger.js";
import { validateRequest } from "../src/requests.js";
import { classify, nextAttemptAt, retryDelayMs } from "../src/retry.js";
import { BlockedTargetError, blockedReason, resolveTarget } from "../src/ssrf.js";
import { FakeVault } from "./fake-vault.js";

test("blocked address ranges, IPv4 and IPv6, including embedded IPv4 forms", () => {
  const blocked = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:10.0.0.1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "2002:7f00:1::",
    "2001:db8::1",
  ];
  for (const ip of blocked) assert.ok(blockedReason(ip), `${ip} must be blocked`);
  const allowed = ["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808", "172.32.0.1", "100.128.0.1"];
  for (const ip of allowed) assert.equal(blockedReason(ip), null, `${ip} must be allowed`);
  assert.ok(blockedReason("not-an-ip"));
});

test("targets: scheme, credentials, DNS answers and the one allowed demo target", async () => {
  const resolver = (map: Record<string, string[]>) => async (host: string) => (map[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  await assert.rejects(resolveTarget("ftp://example.com/"), BlockedTargetError);
  await assert.rejects(resolveTarget("http://user:pw@example.com/"), BlockedTargetError);
  await assert.rejects(resolveTarget("http://127.0.0.1:8080/"), /loopback/);
  await assert.rejects(resolveTarget("http://[::ffff:127.0.0.1]/"), /loopback/);
  await assert.rejects(resolveTarget("http://evil.test/", { resolver: resolver({ "evil.test": ["1.1.1.1", "10.0.0.5"] }) }), /private/);
  await assert.rejects(resolveTarget("http://meta.test/", { resolver: resolver({ "meta.test": ["169.254.169.254"] }) }), /metadata/);
  await assert.rejects(resolveTarget("http://none.test/", { resolver: resolver({}) }), /did not resolve/);
  const ok = await resolveTarget("https://good.test/x", { resolver: resolver({ "good.test": ["1.1.1.1"] }) });
  assert.equal(ok.address, "1.1.1.1");
  assert.equal(ok.port, 443);
  const demo = await resolveTarget("http://127.0.0.1:7611/hook", { allowTarget: "127.0.0.1:7611" });
  assert.equal(demo.address, "127.0.0.1");
  await assert.rejects(resolveTarget("http://127.0.0.1:7612/hook", { allowTarget: "127.0.0.1:7611" }), /loopback/);
});

test("retry classification and schedule", () => {
  assert.equal(classify(200), "delivered");
  assert.equal(classify(204), "delivered");
  assert.equal(classify(404), "permanent");
  assert.equal(classify(400), "permanent");
  assert.equal(classify(408), "retry");
  assert.equal(classify(429), "retry");
  assert.equal(classify(500), "retry");
  assert.equal(classify(503), "retry");
  const mid = () => 0.5; // no jitter
  assert.equal(retryDelayMs(1, undefined, undefined, mid), 1000);
  assert.equal(retryDelayMs(2, undefined, undefined, mid), 5000);
  assert.equal(retryDelayMs(3, undefined, undefined, mid), 30_000);
  assert.equal(retryDelayMs(4, undefined, undefined, mid), 120_000);
  assert.equal(retryDelayMs(5, undefined, undefined, mid), 600_000);
  assert.equal(retryDelayMs(6, undefined, undefined, mid), 3_600_000);
  for (let i = 0; i < 50; i++) {
    const d = retryDelayMs(1);
    assert.ok(d >= 800 && d <= 1200, `jitter within 20%: ${d}`);
  }
  const hour = 3_600_000;
  assert.equal(nextAttemptAt({ acceptedAt: 0, now: 23.5 * hour, attemptsMade: 9, random: mid }), null);
  assert.equal(nextAttemptAt({ acceptedAt: 0, now: 10 * hour, attemptsMade: 9, random: mid }), 11 * hour);
});

test("request validation", () => {
  const base = { url: "https://example.com/hook", method: "post", headers: { "X-Thing": "1" }, body: "{}", idempotency_key: "k1" };
  const ok = validateRequest(base);
  assert.ok(typeof ok !== "string");
  assert.equal(ok.method, "POST");
  assert.deepEqual(ok.headers, { "x-thing": "1" });
  assert.match(String(validateRequest({ ...base, url: "file:///etc/passwd" })), /http/);
  assert.match(String(validateRequest({ ...base, headers: { Host: "x" } })), /may not be set/);
  assert.match(String(validateRequest({ ...base, headers: { "X-Deed-Relay-Key": "x" } })), /may not be set/);
  assert.match(String(validateRequest({ ...base, headers: { "X-A": "a\r\nb: c" } })), /bad value/);
  assert.match(String(validateRequest({ ...base, body: "x".repeat(64 * 1024 + 1) })), /64 KB/);
  assert.match(String(validateRequest({ ...base, idempotency_key: "" })), /idempotency_key/);
  assert.match(String(validateRequest({ ...base, method: "CONNECT" })), /method/);
});

test("NEP-413 auth: good request, replayed nonce, stale clock, wrong recipient, key checks", async () => {
  const fake = new FakeVault();
  const alice = generateSecretKey();
  fake.addCustomer("alice.test", alice.publicKey, 10n ** 6n);
  let now = 1_000_000;
  const auth = new Authenticator(fake.vault, fake.as("none"), () => now);
  const signer = signerFromSecretKey(alice.secretKey);
  const sign = (opts: Partial<Parameters<typeof signRequest>[0]> = {}) =>
    signRequest({ accountId: "alice.test", signer, vault: fake.vault, method: "POST", path: "/v1/deliveries", body: "{}", now, ...opts });
  const body = new TextEncoder().encode("{}");

  const h = sign();
  assert.deepEqual(await auth.verify(h, "POST", "/v1/deliveries", body), { ok: true, accountId: "alice.test" });
  assert.match((await auth.verify(h, "POST", "/v1/deliveries", body) as { error: string }).error, /nonce already used/);
  assert.match((await auth.verify(sign(), "POST", "/v1/deliveries", new TextEncoder().encode("{ }")) as { error: string }).error, /signature/);
  assert.match((await auth.verify(sign(), "GET", "/v1/deliveries", body) as { error: string }).error, /signature/);
  assert.match((await auth.verify(sign({ vault: "other.test" }), "POST", "/v1/deliveries", body) as { error: string }).error, /signature/);
  assert.match((await auth.verify(sign({ now: now - 6 * 60_000 }), "POST", "/v1/deliveries", body) as { error: string }).error, /window/);
  assert.match((await auth.verify(sign({ accountId: "bob.test" }), "POST", "/v1/deliveries", body) as { error: string }).error, /full-access/);
  const stranger = signerFromSecretKey(generateSecretKey().secretKey);
  assert.match((await auth.verify(sign({ signer: stranger }), "POST", "/v1/deliveries", body) as { error: string }).error, /full-access/);
  now += 1000;
  assert.equal((await auth.verify(sign(), "POST", "/v1/deliveries", body)).ok, true);
});

test("charger pre-accounting never accepts more than balance and cap, and batches charges", async () => {
  const fake = new FakeVault();
  fake.setWorker("ed25519:worker");
  fake.price = 100n;
  fake.addCustomer("alice.test", "k", 350n);
  fake.addCustomer("bob.test", "k", 10_000n, 200n);
  const settled: [string, string][] = [];
  const charger = new Charger(fake.as("ed25519:worker"), {
    onSettled: (item: PendingCharge, status: string) => settled.push([item.id, status]),
    onReseq: (item) => item.receiptsRoot,
    onFloor: () => {},
    onBatchFailed: () => {},
    log: () => {},
  });
  const root = sha256Hex("r");
  let n = 0;
  const admit = (c: string) => charger.admit(c, 100n, () => ({ id: `d${++n}`, receiptsRoot: root }));

  for (let i = 0; i < 3; i++) assert.equal((await admit("alice.test")).ok, true);
  const refused = await admit("alice.test");
  assert.equal(refused.ok, false);
  assert.equal(!refused.ok && refused.reason, "insufficient_balance");
  assert.equal((await admit("bob.test")).ok, true);
  assert.equal((await admit("bob.test")).ok, true);
  const capped = await admit("bob.test");
  assert.equal(!capped.ok && capped.reason, "daily_cap_reached");
  const unknown = await admit("carol.test");
  assert.equal(!unknown.ok && unknown.reason, "unknown_customer");
  assert.equal(charger.pendingCount(), 5);

  await charger.flush();
  assert.equal(fake.charges.length, 1);
  assert.equal(fake.charges[0]!.items.length, 5);
  assert.deepEqual(fake.charges[0]!.results.map((r) => r.status), ["charged", "charged", "charged", "charged", "charged"]);
  assert.equal(fake.revenue, 500n);
  assert.equal(settled.length, 5);
  // After the flush the chain view is fresh, and still nothing more fits.
  assert.equal((await admit("alice.test")).ok, false);
  fake.customers.get("alice.test")!.balance += 100n;
  await charger.refreshAll();
  assert.equal((await admit("alice.test")).ok, false, "view is cached for a few seconds");

});

test("a customer with a pending refund is refused, and fresh views are read after 10 s", async () => {
  const fake = new FakeVault();
  fake.setWorker("ed25519:worker");
  fake.addCustomer("bob.test", "k", 10n ** 6n);
  let clock = 0;
  const hooks = { onSettled: () => {}, onReseq: (i: PendingCharge) => i.receiptsRoot, onFloor: () => {}, onBatchFailed: () => {}, log: () => {} };
  const charger = new Charger(fake.as("ed25519:worker"), hooks, () => clock);
  const make = () => ({ id: "x", receiptsRoot: sha256Hex("r") });
  assert.equal((await charger.admit("bob.test", 1n, make)).ok, true);
  fake.customers.get("bob.test")!.refundRequestedAt = 1;
  assert.equal((await charger.admit("bob.test", 1n, make)).ok, true, "cached view");
  clock += 11_000;
  const leaving = await charger.admit("bob.test", 1n, make);
  assert.equal(!leaving.ok && leaving.reason, "refund_pending");
});

test("charger renumbers after a seq gap and never charges a seq twice", async () => {
  const fake = new FakeVault();
  fake.setWorker("ed25519:worker");
  fake.price = 1n;
  fake.addCustomer("alice.test", "k", 1000n);
  const reseqs: number[] = [];
  const charger = new Charger(fake.as("ed25519:worker"), {
    onSettled: () => {},
    onReseq: (item) => {
      reseqs.push(item.seq);
      return item.receiptsRoot;
    },
    onFloor: () => {},
    onBatchFailed: () => {},
    log: () => {},
  });
  const root = sha256Hex("r");
  await charger.admit("alice.test", 1n, () => ({ id: "a", receiptsRoot: root }));
  // Someone else (an earlier worker) charges seq 1 on chain before this worker flushes.
  fake.applyCharge("ed25519:worker", [{ customer: "alice.test", seq: 1, units: 1, receipts_root: root }]);
  await charger.admit("alice.test", 1n, () => ({ id: "b", receiptsRoot: root }));
  await charger.flush();
  // seq 1 is reported duplicate, seq 2 charged: nothing twice.
  assert.deepEqual(fake.charges.at(-1)!.results.map((r) => r.status), ["duplicate", "charged"]);
  assert.equal(fake.revenue, 2n);
  assert.deepEqual(reseqs, []);
});

test("a failed charge transaction keeps the items for the next flush", async () => {
  const fake = new FakeVault();
  fake.setWorker("ed25519:other");
  fake.addCustomer("alice.test", "k", 10n ** 6n);
  const failures: string[] = [];
  const charger = new Charger(fake.as("ed25519:worker"), {
    onSettled: () => {},
    onReseq: (i) => i.receiptsRoot,
    onFloor: () => {},
    onBatchFailed: (e) => failures.push(e),
    log: () => {},
  });
  await charger.admit("alice.test", 10n, () => ({ id: "a", receiptsRoot: sha256Hex("r") }));
  await charger.flush();
  assert.equal(failures.length, 1);
  assert.equal(charger.pendingCount(), 1);
  fake.workerKey = "ed25519:worker";
  await charger.flush();
  assert.equal(charger.pendingCount(), 0);
  assert.equal(fake.revenue, fake.price);
});
