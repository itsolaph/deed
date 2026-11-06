// End to end against a fake vault: a real HTTP worker, a local flaky target, and OutliveClient.
// Ports 7620-7629 (the project keeps local servers in 7600-7699).

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  OutliveClient,
  PaymentRequiredError,
  generateSecretKey,
  sha256Hex,
  signerFromSecretKey,
  verifyOutbound,
  type DeliveryRequest,
} from "@outlive/sdk";
import { fileStore } from "@outlive/sdk/node";

import { Authenticator } from "../src/auth.js";
import { createServer } from "../src/server.js";
import { BlockedTargetError, safeSend } from "../src/ssrf.js";
import { Worker } from "../src/worker.js";
import { FakeVault } from "./fake-vault.js";

const TARGET_PORT = 7620;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "outlive-worker-test-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Hit {
  path: string;
  body: string;
  relayOk: boolean;
  key: string | undefined;
}

/** Answers 500 to the first `failFirst` attempts of each delivery, then 200. */
function startTarget(failFirst: () => number): Promise<{ hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const seen = new Map<string, number>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const check = verifyOutbound(req.headers, { method: req.method ?? "", path: req.url ?? "", bodySha256: sha256Hex(body) });
      hits.push({ path: req.url ?? "", body, relayOk: check.ok, key: check.key });
      const id = check.deliveryId ?? "";
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      res.writeHead(n <= failFirst() ? 500 : 200, { "content-type": "text/plain" });
      res.end(n <= failFirst() ? "try again" : "ok");
    });
  });
  return new Promise((resolve) =>
    server.listen(TARGET_PORT, "127.0.0.1", () => resolve({ hits, close: () => new Promise((r) => server.close(() => r())) })),
  );
}

async function startWorker(fake: FakeVault, port: number, opts: { journal?: string; retired?: () => void; flushMs?: number } = {}) {
  const key = generateSecretKey();
  const signer = signerFromSecretKey(key.secretKey);
  if (fake.workerKey === null) fake.setWorker(signer.publicKey, `http://127.0.0.1:${port}`);
  const chain = fake.as(signer.publicKey);
  const worker = new Worker({
    vault: fake.vault,
    network: "testnet",
    chain,
    signer,
    journalFile: opts.journal ?? path.join(TMP, `journal-${port}-${Date.now()}.jsonl`),
    publicUrl: `http://127.0.0.1:${port}`,
    allowTarget: `127.0.0.1:${TARGET_PORT}`,
    retrySchedule: [100, 200, 300],
    hourlyMs: 300,
    flushIntervalMs: opts.flushMs ?? 100,
    watchIntervalMs: 100,
    handoffDelayMs: 100,
    log: () => {},
    ...(opts.retired ? { onRetired: opts.retired } : {}),
  });
  return { worker, signer, key, chain, port, start: async () => {
    await worker.start();
    const server = createServer(worker, new Authenticator(fake.vault, chain));
    await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
    return () => new Promise<void>((r) => { worker.stop(); server.closeAllConnections(); server.close(() => r()); });
  } };
}

function customer(fake: FakeVault, account: string, balance: bigint) {
  const key = generateSecretKey();
  fake.addCustomer(account, key.publicKey, balance);
  const views = {
    info: async () => fake.infoView(),
    workerHistory: async () => fake.history.slice(-10),
    customer: async (a: string) => fake.customerView(a),
  };
  const events: string[] = [];
  const client = new OutliveClient({ vault: fake.vault, accountId: account, signer: signerFromSecretKey(key.secretKey), views, keyCacheMs: 0, onEvent: (e) => events.push(e) });
  return { client, events };
}

function request(i: number): DeliveryRequest {
  return { url: `http://127.0.0.1:${TARGET_PORT}/hook?n=${i}`, method: "POST", headers: { "x-test": String(i) }, body: JSON.stringify({ n: i }), idempotency_key: `k${i}` };
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

test("paid delivery: 402 first, then receipt, retries, signed proofs, one charge per delivery", async () => {
  const target = await startTarget(() => 1);
  const fake = new FakeVault();
  const w = await startWorker(fake, 7621);
  const stop = await w.start();
  try {
    // Unknown customer: 402 with the exact way to pay.
    const strangerKey = generateSecretKey();
    fake.fullKeys.set("carol.test", new Set([strangerKey.publicKey]));
    const carol = new OutliveClient({ vault: fake.vault, accountId: "carol.test", signer: signerFromSecretKey(strangerKey.secretKey), views: { info: async () => fake.infoView(), workerHistory: async () => fake.history, customer: async () => null } });
    const err = await carol.deliver(request(0)).catch((e) => e);
    assert.ok(err instanceof PaymentRequiredError);
    assert.equal(err.details.reason, "unknown_customer");
    assert.equal(err.details.how_to_pay.method, "ft_transfer_call");
    assert.equal(err.details.how_to_pay.args.receiver_id, fake.vault);
    assert.match(err.details.how_to_pay.near_cli, /ft_transfer_call/);

    const { client } = customer(fake, "alice.test", 1_000_000n);
    const a = await client.deliver(request(1));
    assert.equal(a.receipt.payload.customer, "alice.test");
    assert.equal(a.receipt.payload.worker_public_key, w.signer.publicKey);
    // Same idempotency key: same delivery, no second charge.
    const again = await client.deliver(request(1));
    assert.equal(again.delivery_id, a.delivery_id);
    await client.deliver(request(2));

    await until(async () => (await client.track()).pending === 0);
    assert.equal(client.pendingCount(), 0, "finished deliveries are forgotten by track()");
    const status = await client.status(a.delivery_id);
    assert.equal(status.state, "delivered");
    assert.deepEqual(status.attempts.map((p) => p.payload.status_code), [500, 200]);
    await w.worker.flushCharges();
    assert.equal(fake.revenue, 2n * fake.price);
    assert.equal(fake.customers.get("alice.test")!.lastSeq, 2);
    // Every outbound request carried a valid relay signature by the worker key.
    assert.ok(target.hits.length >= 4);
    assert.ok(target.hits.every((h) => h.relayOk && h.key === w.signer.publicKey));
  } finally {
    await stop();
    await target.close();
  }
});

test("a retry that arrives while the first request is still being admitted gets the same delivery", async () => {
  const target = await startTarget(() => 0);
  const fake = new FakeVault();
  const w = await startWorker(fake, 7628);
  const stop = await w.start();
  try {
    fake.addCustomer("dave.test", generateSecretKey().publicKey, 1_000_000n);
    // Both copies pass the idempotency check before either finishes its (async) admission,
    // like a client that timed out on a slow worker and sent the same request again.
    const [a, b] = await Promise.all([w.worker.deliver("dave.test", request(7)), w.worker.deliver("dave.test", request(7))]);
    const ids = [a, b].map((r) => (r.body as { delivery_id: string }).delivery_id);
    assert.equal(ids[0], ids[1], "one delivery for one idempotency key");
    assert.deepEqual([a.status, b.status].sort(), [200, 202]);
    await w.worker.flushCharges();
    assert.equal(fake.customers.get("dave.test")!.lastSeq, 1, "charged once");
    assert.equal(fake.revenue, fake.price);
  } finally {
    await stop();
    await target.close();
  }
});

test("a redirect to a blocked address is refused at the hop", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { location: "http://127.0.0.1:7629/internal" });
    res.end();
  });
  await new Promise<void>((r) => server.listen(TARGET_PORT, "127.0.0.1", () => r()));
  try {
    await assert.rejects(
      safeSend({ url: `http://127.0.0.1:${TARGET_PORT}/start`, method: "POST", headers: {}, body: "{}" }, { allowTarget: `127.0.0.1:${TARGET_PORT}` }),
      (e: Error) => e instanceof BlockedTargetError && /loopback/.test(e.message),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("status shows every attempt with a proof; blocked targets are refused before charging", async () => {
  const target = await startTarget(() => 2);
  const fake = new FakeVault();
  const w = await startWorker(fake, 7622);
  const stop = await w.start();
  try {
    const { client } = customer(fake, "alice.test", 1_000_000n);
    const a = await client.deliver(request(1));
    await until(async () => (await client.status(a.delivery_id)).state === "delivered");
    const s = await client.status(a.delivery_id);
    assert.deepEqual(s.attempts.map((p) => p.payload.status_code), [500, 500, 200]);
    assert.deepEqual(s.attempts.map((p) => p.payload.attempt), [1, 2, 3]);

    const blocked = await client.deliver({ ...request(9), url: "http://127.0.0.1:7629/x" }).catch((e) => e);
    assert.equal(blocked.status, 400);
    assert.match(JSON.stringify(blocked.body), /loopback/);
    await w.worker.flushCharges();
    assert.equal(fake.revenue, fake.price, "only the accepted delivery was charged");
  } finally {
    await stop();
    await target.close();
  }
});

test("pre-accounting: the worker stops accepting when the balance is used up", async () => {
  const target = await startTarget(() => 0);
  const fake = new FakeVault();
  fake.price = 400_000n;
  const w = await startWorker(fake, 7623);
  const stop = await w.start();
  try {
    const { client } = customer(fake, "bob.test", 1_000_000n);
    await client.deliver(request(1));
    await client.deliver(request(2));
    const third = await client.deliver(request(3)).catch((e) => e);
    assert.ok(third instanceof PaymentRequiredError);
    assert.equal(third.details.reason, "insufficient_balance");
    await w.worker.flushCharges();
    assert.equal(fake.customers.get("bob.test")!.balance, 200_000n);
  } finally {
    await stop();
    await target.close();
  }
});

test("handover: old worker answers 410 and hands off; new worker delivers without charging twice", async () => {
  let failing = true;
  const target = await startTarget(() => (failing ? 1000 : 0));
  const fake = new FakeVault();
  let retired = false;
  const a = await startWorker(fake, 7624, { retired: () => (retired = true) });
  const stopA = await a.start();
  const { client, events } = customer(fake, "alice.test", 1_000_000n);

  // Two deliveries charged by A, one accepted but not yet charged when the key rotates.
  const d1 = await client.deliver(request(1));
  const d2 = await client.deliver(request(2));
  await a.worker.flushCharges();
  assert.equal(fake.customers.get("alice.test")!.lastSeq, 2);
  const revenueBefore = fake.revenue;

  // The buyer starts worker B and rotates key and endpoint in one step.
  const b = await startWorker(fake, 7625);
  fake.setWorker(b.signer.publicKey, "http://127.0.0.1:7625");
  const stopB = await b.start();
  // A accepted d3 just before it noticed; its charge can no longer go through with A's key.
  const d3 = await (async () => {
    const res = await client.deliver(request(3)).catch((e) => e);
    return res;
  })();
  try {
    await until(() => retired, 5000);
    // B took over every pending obligation from A's hand-off.
    failing = false;
    await until(async () => (await client.track()).pending === 0, 5000);
    await b.worker.flushCharges();
    // d1 and d2 were charged by A and not again by B.
    const bCharges = fake.charges.filter((c) => c.signer === b.signer.publicKey).flatMap((c) => c.items);
    for (const item of bCharges) assert.ok(item.seq > 2, "B never re-charges seqs A charged");
    const charged = fake.charges.flatMap((c) => c.results).filter((r) => r.status === "charged").length;
    assert.equal(charged, 3, "three deliveries, three charges in total");
    assert.equal(fake.revenue - revenueBefore, fake.price);
    assert.ok(d1.delivery_id && d2.delivery_id && d3);
    // The client saw the move.
    assert.ok(events.includes("worker_gone") || events.includes("connection_failed") || events.includes("endpoint_changed"));
    // New deliveries go to B.
    const d4 = await client.deliver(request(4));
    assert.equal(d4.receipt.payload.worker_public_key, b.signer.publicKey);
  } finally {
    await stopA().catch(() => undefined);
    await stopB();
    await target.close();
  }
});

test("delivered but uncharged work is refused by the hand-off; the customer's receipt recovers it", async () => {
  const target = await startTarget(() => 0);
  const fake = new FakeVault();
  let retired = false;
  const a = await startWorker(fake, 7624, { retired: () => (retired = true), flushMs: 60_000 });
  const stopA = await a.start();
  const { client } = customer(fake, "alice.test", 1_000_000n);
  const d = await client.deliver(request(1));
  await until(async () => (await client.status(d.delivery_id)).state === "delivered");
  const hitsBefore = target.hits.length;
  assert.equal(fake.revenue, 0n, "A never flushed its charge");

  const b = await startWorker(fake, 7625);
  fake.setWorker(b.signer.publicKey, "http://127.0.0.1:7625");
  const stopB = await b.start();
  try {
    await until(() => retired, 5000);
    // Revocation: the hand-off carries only settled work, even with valid delivery proofs
    // (a revoked key could forge those). The customer's own presentation is the recovery path.
    assert.equal(b.worker.status("alice.test", d.delivery_id).status, 404);
    await b.worker.flushCharges();
    assert.equal(fake.revenue, 0n, "B does not bill A's obligation behind the customer's back");
    assert.equal(target.hits.length, hitsBefore, "not delivered again behind the customer's back");
    // The customer still holds the receipt and presents it: charged and delivered exactly once.
    const res = await b.worker.acceptObligations("alice.test", { entries: [{ request: request(1), receipt: d.receipt }] });
    assert.equal((res.body as { results: { result: string; charged_as_new?: boolean }[] }).results[0]!.charged_as_new, true);
    await until(async () => target.hits.length > hitsBefore, 5000);
    await b.worker.flushCharges();
    assert.equal(fake.revenue, fake.price, "charged once, by B");
  } finally {
    await stopA().catch(() => undefined);
    await stopB();
    await target.close();
  }
});

test("a customer can present an old receipt to the new worker after the old one vanished", async () => {
  const target = await startTarget(() => 1000);
  const fake = new FakeVault();
  const a = await startWorker(fake, 7626);
  const stopA = await a.start();
  const { client } = customer(fake, "alice.test", 1_000_000n);
  const charged = await client.deliver(request(1));
  await a.worker.flushCharges();
  const uncharged = await client.deliver(request(2));
  // Worker A dies without a hand-off.
  await stopA();

  const b = await startWorker(fake, 7627);
  fake.setWorker(b.signer.publicKey, "http://127.0.0.1:7627");
  const stopB = await b.start();
  try {
    const results = await client.represent();
    const byId = new Map(results.map((r) => [r.delivery_id, r]));
    assert.equal(byId.get(charged.delivery_id)!.result, "accepted");
    assert.equal(byId.get(charged.delivery_id)!.charged_as_new, false);
    assert.equal(byId.get(uncharged.delivery_id)!.result, "accepted");
    assert.equal(byId.get(uncharged.delivery_id)!.charged_as_new, true);
    assert.equal(byId.get(uncharged.delivery_id)!.receipt!.payload.worker_public_key, b.signer.publicKey);
    // Presenting again is idempotent.
    const again = await client.represent();
    assert.ok(again.every((r) => r.result === "known"));
    // A forged receipt (signed by a key the vault never registered) is refused.
    const forger = signerFromSecretKey(generateSecretKey().secretKey);
    const forged = { ...client.pendingEntries()[0]!, receipt: { payload: { ...charged.receipt.payload, delivery_id: "d_" + "ab".repeat(12), worker_public_key: forger.publicKey }, signature: "" } };
    forged.receipt.signature = Buffer.from(forger.sign(new TextEncoder().encode("x"))).toString("base64");
    const res = await b.worker.acceptObligations("alice.test", { entries: [forged] });
    assert.equal((res.body as { results: { result: string }[] }).results[0]!.result, "rejected");
    await b.worker.flushCharges();
    assert.equal(fake.revenue, 2n * fake.price, "each delivery paid exactly once");
  } finally {
    await stopB();
    await target.close();
  }
});

test("track() presents receipts again when the new worker came up after the client noticed the move", async () => {
  let down = true;
  const target = await startTarget(() => (down ? 1000 : 0));
  const fake = new FakeVault();
  const a = await startWorker(fake, 7626);
  const stopA = await a.start();
  const { client } = customer(fake, "alice.test", 1_000_000n);
  const d = await client.deliver(request(1));
  await a.worker.flushCharges();
  await stopA();
  // The key moves to B, but B is not up yet: the client's first look fails.
  const b = await startWorker(fake, 7627);
  fake.setWorker(b.signer.publicKey, "http://127.0.0.1:7627");
  await assert.rejects(client.track());
  const stopB = await b.start();
  try {
    down = false;
    await client.track(); // 404 at B, so the receipt is presented again
    await until(async () => (await client.track()).pending === 0, 5000);
    assert.equal(b.worker.status("alice.test", d.delivery_id).status, 200);
    await b.worker.flushCharges();
    assert.equal(fake.revenue, fake.price, "charged once, by A");
  } finally {
    await stopB();
    await target.close();
  }
});

test("hostile seller: worker A killed without hand-off; a restarted customer resubmits saved receipts to B; nothing is charged twice; a refunding customer keeps its uncharged credit", async () => {
  let down = false;
  const target = await startTarget(() => (down ? 1000 : 0));
  const fake = new FakeVault();
  // A never hands off (it is killed before it can see the rotation) and flushes only when told.
  const a = await startWorker(fake, 7626, { flushMs: 60_000 });
  const stopA = await a.start();
  const store = path.join(TMP, "alice-pending.json");
  const aliceKey = generateSecretKey();
  fake.addCustomer("alice.test", aliceKey.publicKey, 1_000_000n);
  const views = { info: async () => fake.infoView(), workerHistory: async () => fake.history.slice(-10), customer: async (x: string) => fake.customerView(x) };
  const alice = new OutliveClient({ vault: fake.vault, accountId: "alice.test", signer: signerFromSecretKey(aliceKey.secretKey), views, keyCacheMs: 0, store: fileStore(store) });
  const { client: bob } = customer(fake, "bob.test", 1_000_000n);

  // Charged and delivered.
  const d1 = await alice.deliver(request(1));
  await until(async () => (await alice.track()).pending === 0);
  // Charged, not delivered (target down).
  down = true;
  const d2 = await alice.deliver(request(2));
  const d3 = await alice.deliver(request(3));
  const b1 = await bob.deliver(request(11));
  await a.worker.flushCharges();
  // Accepted, neither charged nor delivered when A dies.
  const d4 = await alice.deliver(request(4));
  const d5 = await alice.deliver(request(5));
  const b2 = await bob.deliver(request(12));
  assert.equal(fake.customers.get("alice.test")!.lastSeq, 3);
  assert.equal(fake.revenue, 4n * fake.price, "d1, d2, d3, b1 charged by A");

  // The seller kills A: no flush, no hand-off. The buyer starts B and rotates key and endpoint.
  await stopA();
  const b = await startWorker(fake, 7627);
  fake.setWorker(b.signer.publicKey, "http://127.0.0.1:7627");
  const stopB = await b.start();
  try {
    // A's key can no longer charge anything, even if its process came back.
    // (A raw charge call: A's process is dead, so none of its own hand-off code runs.)
    const late = await a.chain.charge([{ customer: "alice.test", seq: 4, units: 1, receipts_root: "ab".repeat(32) }]);
    assert.equal(late.ok, false, "a late charge with A's key is refused as a whole");
    assert.match(late.error ?? "", /not the registered worker key/);
    assert.equal(fake.revenue, 4n * fake.price);

    // Alice's process restarts: a new client loads the saved receipts and resubmits them to the
    // endpoint the vault publishes now.
    down = false;
    const alice2 = new OutliveClient({ vault: fake.vault, accountId: "alice.test", signer: signerFromSecretKey(aliceKey.secretKey), views, keyCacheMs: 0, store: fileStore(store) });
    assert.deepEqual(alice2.pendingEntries().map((e) => e.receipt.payload.delivery_id).sort(), [d2, d3, d4, d5].map((d) => d.delivery_id).sort());
    const results = new Map((await alice2.resubmit()).map((r) => [r.delivery_id, r]));
    assert.equal(results.get(d2.delivery_id)!.charged_as_new, false, "charged by A: delivered by B for free");
    assert.equal(results.get(d3.delivery_id)!.charged_as_new, false);
    assert.equal(results.get(d4.delivery_id)!.charged_as_new, true, "never charged: B charges it once");
    assert.equal(results.get(d5.delivery_id)!.charged_as_new, true);
    await until(async () => (await alice2.track()).pending === 0, 5000);
    assert.deepEqual(JSON.parse(fs.readFileSync(store, "utf8")).entries, [], "the store is empty once everything is delivered");

    // Bob asks for his money back instead: the receipt A charged is still delivered, the
    // uncharged one is refused and its price stays in his refundable credit.
    fake.customers.get("bob.test")!.refundRequestedAt = Date.now();
    const bobResults = new Map((await bob.resubmit()).map((r) => [r.delivery_id, r]));
    assert.equal(bobResults.get(b1.delivery_id)!.result, "accepted");
    assert.equal(bobResults.get(b2.delivery_id)!.result, "rejected");
    assert.match(bobResults.get(b2.delivery_id)!.reason!, /refund_pending/);
    assert.deepEqual(bob.rejectedEntries(), [], "a refund request can be cancelled; do not discard the saved obligation");
    assert.deepEqual(bob.pendingEntries().map((e) => e.receipt.payload.delivery_id), [b1.delivery_id, b2.delivery_id]);

    await until(() => target.hits.some((h) => h.relayOk && h.key === b.signer.publicKey && h.path.endsWith("n=11")), 5000);
    await b.worker.flushCharges();
    const charged = fake.charges.flatMap((c) => c.results).filter((r) => r.status === "charged");
    assert.equal(charged.length, 6, "d1..d5 and b1: six deliveries, six charges, none twice");
    assert.equal(fake.customers.get("alice.test")!.balance, 1_000_000n - 5n * fake.price);
    assert.equal(fake.customers.get("bob.test")!.balance, 1_000_000n - fake.price, "b2 was never charged; it is refundable");
    const delivered = new Set(target.hits.filter((h) => h.relayOk).map((h) => h.path));
    for (const n of [1, 2, 3, 4, 5, 11]) assert.ok([...delivered].some((p) => p.endsWith(`n=${n}`)), `delivery ${n} reached the target`);
    assert.ok(d1.delivery_id);
  } finally {
    await stopB();
    await target.close();
  }
});

test("restart: the journal brings back pending deliveries and nothing is charged twice", async () => {
  const target = await startTarget(() => 1000);
  const fake = new FakeVault();
  const journal = path.join(TMP, "restart.jsonl");
  const first = await startWorker(fake, 7628, { journal });
  const stop1 = await first.start();
  const { client } = customer(fake, "alice.test", 1_000_000n);
  const d = await client.deliver(request(1));
  await first.worker.flushCharges();
  await stop1();

  // Same key, same journal.
  const worker2 = new Worker({
    vault: fake.vault,
    network: "testnet",
    chain: first.chain,
    signer: first.signer,
    journalFile: journal,
    publicUrl: "http://127.0.0.1:7628",
    allowTarget: `127.0.0.1:${TARGET_PORT}`,
    retrySchedule: [100],
    hourlyMs: 200,
    flushIntervalMs: 100,
    watchIntervalMs: 100,
    log: () => {},
  });
  await worker2.start();
  try {
    const status = worker2.status("alice.test", d.delivery_id);
    assert.equal(status.status, 200);
    assert.equal((status.body as { state: string }).state, "pending");
    await worker2.flushCharges();
    assert.equal(fake.revenue, fake.price);
  } finally {
    worker2.stop();
    await target.close();
  }
});
