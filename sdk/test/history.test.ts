import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildEarningsHistory,
  eventsFromTransactions,
  parseEventLog,
  readVaultHistory,
  reconcile,
  TxIndex,
  type FetchLike,
  type HistoryEvent,
  type IndexedAccountTx,
  type IndexedTransaction,
} from "../src/index.js";

// Recorded from FastNEAR's testnet index (scripts/record-history-fixture.mjs): the demo vault
// relay-1102ripe, minted by outlive-seller, sold for 3 tUSDC to outlive-buyer (epoch 2).
const VAULT = "relay-1102ripe.outlive.testnet";
const fixture = JSON.parse(readFileSync(new URL(`../../test/fixtures/${VAULT}.json`, import.meta.url), "utf8")) as {
  vault: string;
  account: { account_txs: IndexedAccountTx[]; txs_count: number };
  transactions: IndexedTransaction[];
};
const SALE_TX = "HaMeB1JePtBkSPYPsV9W2oLj86jvnJjNG3VYHaVEsZVR";
const MINT_TX = "HJtBcxvVvdPRLamQK1tYEqBsWjMcK8FFTvzMjnm6xGfU";
const SELLER = "outlive-seller.testnet";
const BUYER = "outlive-buyer.testnet";

test("history: the recorded demo vault splits into two epochs at the sale", () => {
  const h = buildEarningsHistory(eventsFromTransactions(fixture.transactions, VAULT), VAULT);
  assert.equal(h.fromMint, true);
  assert.deepEqual(h.epochs.map((e) => e.epoch), [2, 1], "newest first");
  const [now, first] = h.epochs as [NonNullable<(typeof h.epochs)[0]>, NonNullable<(typeof h.epochs)[0]>];

  assert.equal(first.holder, SELLER);
  assert.equal(first.openedBy, "mint");
  assert.equal(first.opened?.tx, MINT_TX);
  assert.equal(first.calls, 61);
  assert.equal(first.revenue, "610000");
  assert.equal(first.withdrawn, "610000");
  assert.equal(first.payouts.length, 1);
  assert.equal(first.payouts[0]!.receiver, SELLER);
  assert.equal(first.chargeTxs.length, 7);
  assert.deepEqual(first.ended && { ...first.ended, atMs: 0 }, { by: "sale", price: "3000000", buyer: BUYER, tx: SALE_TX, atMs: 0 });
  assert.equal(first.toMs, now.fromMs);
  assert.equal(first.cashOut, "0", "the seller withdrew everything before the sale");

  assert.equal(now.holder, BUYER);
  assert.equal(now.openedBy, "sale");
  assert.equal(now.opened?.tx, SALE_TX);
  assert.equal(now.toMs, null);
  assert.equal(now.ended, null);
  assert.equal(now.calls, 62);
  assert.equal(now.revenue, "620000");
  assert.equal(now.withdrawn, "620000");
  assert.equal(now.payouts[0]!.receiver, BUYER);

  assert.deepEqual(h.totals, { holders: 2, epochs: 2, calls: 123, revenue: "1230000", withdrawn: "1230000", sales: 1, salesVolume: "3000000" });
});

test("history: reconciles with the vault's own counters, and reports a shortfall", () => {
  const h = buildEarningsHistory(eventsFromTransactions(fixture.transactions, VAULT), VAULT);
  // get_stats / get_info of the vault when the fixture was recorded.
  assert.deepEqual(reconcile(h, { callsTotal: 123, revenueTotal: "1230000", cash: "0", inFlight: "0" }), { calls: 0, revenue: 0n, withdrawn: 0n, matches: true });
  const behind = reconcile(h, { callsTotal: 130, revenueTotal: "1300000", cash: "70000" });
  assert.equal(behind.matches, false);
  assert.equal(behind.calls, 7);
  assert.equal(behind.revenue, 70000n);
  assert.equal(behind.withdrawn, 0n);
});

test("history: transaction order in the input does not matter", () => {
  const a = buildEarningsHistory(eventsFromTransactions(fixture.transactions, VAULT), VAULT);
  const b = buildEarningsHistory(eventsFromTransactions([...fixture.transactions].reverse(), VAULT), VAULT);
  assert.deepEqual(b, a);
});

test("history: logs of failed receipts and of other tokens are ignored", () => {
  const evt = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "outlive", version: "1.0.0", event, data: [data] })}`;
  const receipt = (executor: string, logs: string[], status: Record<string, unknown>, index: number) => ({
    receipt: { receipt_id: `r${index}`, receiver_id: executor, predecessor_id: executor },
    execution_outcome: { block_height: 100 + index, block_timestamp: `${(1_700_000_000_000 + index) * 1_000_000}`, index: 0, id: `o${index}`, outcome: { logs, executor_id: executor, status } },
  });
  const tx: IndexedTransaction = {
    transaction: { hash: "T1", signer_id: "x.testnet", receiver_id: VAULT },
    receipts: [
      receipt(VAULT, [evt("vault_withdraw", { receiver_id: SELLER, amount: "5", owner_epoch: 1 })], { Failure: "panicked" }, 1),
      receipt("outlive.testnet", [evt("outlive_sold", { token_id: "relay-other", seller: SELLER, buyer: BUYER, price: "9", epoch: 2 })], { SuccessValue: "" }, 2),
      receipt("evil.testnet", [evt("vault_charge", { earned: "999", items: [{ units: 9, cost: "999" }] })], { SuccessValue: "" }, 3),
      receipt(VAULT, ["not an event", "EVENT_JSON:{broken", evt("vault_charge", { earned: "20", items: [{ units: 1, cost: "10" }, { units: 1, cost: "10" }, { units: 1, cost: "0", status: "cap" }] })], { SuccessValue: "" }, 4),
    ],
  };
  const ev = eventsFromTransactions([tx], VAULT);
  assert.deepEqual(ev.map((e) => e.kind), ["charge"]);
  assert.equal((ev[0] as Extract<HistoryEvent, { kind: "charge" }>).calls, 2, "refused items are not paid calls");
  assert.equal(parseEventLog("EVENT_JSON:{\"standard\":\"outlive\"}"), null);
  assert.equal(parseEventLog("hello"), null);
});

const base = (tx: string, blockHeight: number) => ({ tx, blockHeight, order: 0, logIndex: 0, atMs: blockHeight * 1000 });

test("history: a transfer without a sale carries the unwithdrawn cash to the next holder", () => {
  const events: HistoryEvent[] = [
    { ...base("mint", 1), kind: "init", owner: "a.testnet", epoch: 1 },
    { ...base("c1", 2), kind: "charge", calls: 3, earned: "30" },
    { ...base("w1", 3), kind: "withdraw", receiver: "a.testnet", amount: "10", epoch: 1 },
    { ...base("give", 4), kind: "owner", previous: "a.testnet", owner: "b.testnet", epoch: 2 },
    { ...base("c2", 5), kind: "charge", calls: 1, earned: "10" },
    { ...base("w2", 6), kind: "withdraw", receiver: "b.testnet", amount: "30", epoch: 2 },
  ];
  const h = buildEarningsHistory(events, VAULT);
  const [two, one] = h.epochs;
  assert.deepEqual(one!.ended, { by: "transfer", to: "b.testnet", tx: "give", atMs: 4000 });
  assert.equal(one!.cashOut, "20");
  assert.equal(two!.openedBy, "transfer");
  assert.equal(two!.cashIn, "20");
  assert.equal(two!.withdrawn, "30", "the new holder may withdraw cash earned before the transfer");
  assert.equal(two!.cashOut, "0");
  assert.equal(h.totals.sales, 0);
  assert.equal(h.totals.holders, 2);
});

test("history: without the mint, charges go to the epoch before the first owner change", () => {
  const events: HistoryEvent[] = [
    { ...base("c1", 2), kind: "charge", calls: 4, earned: "40" },
    { ...base("buy", 3), kind: "sold", seller: "b.testnet", buyer: "c.testnet", price: "500", epoch: 3 },
    { ...base("buy", 3), kind: "owner", previous: "b.testnet", owner: "c.testnet", epoch: 3 },
  ];
  const h = buildEarningsHistory(events, VAULT);
  assert.equal(h.fromMint, false);
  const [three, two] = h.epochs;
  assert.equal(two!.epoch, 2);
  assert.equal(two!.holder, "b.testnet");
  assert.equal(two!.openedBy, "unknown");
  assert.equal(two!.fromMs, null);
  assert.equal(two!.calls, 4);
  assert.equal(two!.ended?.by, "sale");
  assert.equal(three!.openedBy, "sale");
});

/** A fake index over the fixture that counts requests and checks the batch limit. */
function fakeIndex(nowListed = fixture.account.account_txs): { index: TxIndex; calls: string[] } {
  const calls: string[] = [];
  const byHash = new Map(fixture.transactions.map((t) => [t.transaction.hash, t]));
  const fetchFn: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as { tx_hashes?: string[] };
    calls.push(url);
    if (url.endsWith("/v0/account")) return { ok: true, status: 200, json: async () => ({ account_txs: nowListed, txs_count: nowListed.length }) };
    assert.ok(body.tx_hashes!.length <= 20);
    return { ok: true, status: 200, json: async () => ({ transactions: body.tx_hashes!.map((h) => byHash.get(h)!) }) };
  };
  return { index: new TxIndex("https://index.test", fetchFn), calls };
}

test("history read: first open reads every transaction, a later open only the list", async () => {
  const later = Date.now();
  const { index, calls } = fakeIndex();
  const first = await readVaultHistory(index, VAULT, undefined, { nowMs: later });
  assert.equal(first.requests, 3, "1 list + 26 transactions in 2 batches");
  assert.equal(calls.length, 3);
  assert.equal(first.unread, 0);
  assert.equal(first.settled.length, 26);
  assert.equal(buildEarningsHistory(first.events, VAULT).totals.calls, 123);

  const again = fakeIndex();
  const second = await readVaultHistory(again.index, VAULT, first, { nowMs: later });
  assert.equal(second.requests, 1);
  assert.deepEqual(buildEarningsHistory(second.events, VAULT), buildEarningsHistory(first.events, VAULT));
});

test("history read: the batch cap leaves the newest unread, and young transactions stay unsettled", async () => {
  const { index } = fakeIndex();
  const capped = await readVaultHistory(index, VAULT, undefined, { maxBatches: 1, nowMs: Date.now() });
  assert.equal(capped.requests, 2);
  assert.equal(capped.unread, 6);
  assert.equal(buildEarningsHistory(capped.events, VAULT).fromMint, true, "oldest first, so the mint is read");

  const newestMs = Number(BigInt(fixture.account.account_txs[0]!.tx_block_timestamp) / 1_000_000n);
  const young = await readVaultHistory(fakeIndex().index, VAULT, undefined, { nowMs: newestMs + 1000 });
  assert.ok(young.settled.length < 26, "transactions under two minutes old are read again next time");
  const next = await readVaultHistory(fakeIndex().index, VAULT, young, { nowMs: newestMs + 1000 });
  assert.equal(next.requests, 2, "the list plus one batch for the unsettled ones");
  assert.equal(buildEarningsHistory(next.events, VAULT).totals.calls, 123, "re-read transactions are not counted twice");
});
