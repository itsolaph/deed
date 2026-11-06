import assert from "node:assert/strict";
import { test } from "node:test";

import {
  appraise,
  DEMO_POLICY,
  eventsFromTransactions,
  inboundTransfers,
  isProjectDemoAccount,
  ownersFromEvents,
  policyByName,
  readFunding,
  revenueByCustomer,
  STRICT_POLICY,
  TxIndex,
  type AppraisalInput,
  type FetchLike,
  type FundingRecord,
  type HistoryEvent,
  type IndexedTransaction,
} from "../src/index.js";

const VAULT = "relay.outlive.testnet";
const OUTLIVE = "outlive.testnet";
const TOKEN = "tusdc.testnet";
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

let h = 0;
const at = (ms: number) => ({ tx: `t${++h}`, blockHeight: h, order: 0, logIndex: 0, atMs: ms });
const charge = (ms: number, ...items: [string, number][]): HistoryEvent => ({
  ...at(ms),
  kind: "charge",
  calls: items.length,
  earned: String(items.reduce((n, [, c]) => n + c, 0)),
  items: items.map(([customer, cost]) => ({ customer, units: 1, cost: String(cost) })),
});
const deposit = (ms: number, customer: string, sender = customer, amount = 5_000_000): HistoryEvent => ({ ...at(ms), kind: "deposit", customer, sender, amount: String(amount) });
const init = (owner: string): HistoryEvent => ({ ...at(NOW - 100 * HOUR), kind: "init", owner, epoch: 1 });

const clean: FundingRecord = { funders: [{ account: "testnet", tx: "faucet", how: "signed a transaction touching the account" }], complete: true };

function input(events: HistoryEvent[], funding: Record<string, FundingRecord>, over: Partial<AppraisalInput> = {}): AppraisalInput {
  return {
    vault: VAULT,
    outlive: OUTLIVE,
    owner: "seller.testnet",
    events,
    funding: new Map(Object.entries(funding)),
    revenue30d: 0n,
    vaultCreatedAtMs: NOW - 100 * HOUR,
    nowMs: NOW,
    ...over,
  };
}

const check = (a: ReturnType<typeof appraise>, name: string) => a.checks.find((c) => c.name === name)!;

/** Three self-funded customers with even revenue: the honest case. */
function honest(): HistoryEvent[] {
  return [
    init("seller.testnet"),
    deposit(NOW - 50 * HOUR, "a.testnet"),
    deposit(NOW - 50 * HOUR, "b.testnet"),
    deposit(NOW - 50 * HOUR, "c.testnet"),
    charge(NOW - 40 * HOUR, ["a.testnet", 10_000], ["b.testnet", 10_000], ["c.testnet", 10_000]),
    charge(NOW - 30 * HOUR, ["a.testnet", 10_000], ["b.testnet", 10_000]),
  ];
}

test("appraisal: honest customers pass the strict policy and all their revenue counts", () => {
  const a = appraise(input(honest(), { "a.testnet": clean, "b.testnet": clean, "c.testnet": clean }, { revenue30d: 50_000n }), STRICT_POLICY);
  assert.equal(a.independentRevenue, 50_000n);
  assert.deepEqual(a.payers.map((p) => p.payer), ["a.testnet", "b.testnet", "c.testnet"]);
  assert.ok(a.checks.every((c) => c.ok), JSON.stringify(a.checks.filter((c) => !c.ok)));
  assert.deepEqual(a.excluded, { owner: 0n, ownerFunded: 0n, unverified: 0n, unattributed: 0n });
});

test("appraisal gate: too few independent customers", () => {
  const events = honest().filter((e) => !(e.kind === "deposit" && e.customer === "c.testnet"));
  const two = events.map((e) => (e.kind === "charge" ? { ...e, items: e.items!.filter((i) => i.customer !== "c.testnet") } : e));
  const a = appraise(input(two, { "a.testnet": clean, "b.testnet": clean }), STRICT_POLICY);
  assert.equal(check(a, "independent paying customers").ok, false);
  assert.match(check(a, "independent paying customers").detail, /2 independent of 2 paying customers, need 3/);
  assert.equal(appraise(input(two, { "a.testnet": clean, "b.testnet": clean }), DEMO_POLICY).checks.every((c) => c.ok), true, "the demo policy accepts two");
});

test("appraisal gate: one customer above the share limit", () => {
  const events = [...honest(), charge(NOW - 20 * HOUR, ["a.testnet", 200_000])];
  const a = appraise(input(events, { "a.testnet": clean, "b.testnet": clean, "c.testnet": clean }), STRICT_POLICY);
  const c = check(a, "no single customer dominates");
  assert.equal(c.ok, false);
  assert.match(c.detail, /largest payer a\.testnet has 88% of independent revenue, limit 60%/);
});

test("appraisal gate: vault younger than the minimum age", () => {
  const a = appraise(input(honest(), { "a.testnet": clean, "b.testnet": clean, "c.testnet": clean }, { vaultCreatedAtMs: NOW - 10 * HOUR }), STRICT_POLICY);
  assert.equal(check(a, "vault observed long enough").ok, false);
  assert.match(check(a, "vault observed long enough").detail, /10\.0 h old, need 72 h/);
  assert.equal(appraise(input(honest(), {}, { vaultCreatedAtMs: NOW - 60_000 }), DEMO_POLICY).checks.find((c) => c.name === "vault observed long enough")!.ok, true);
});

test("appraisal: the owner and every previous owner paying their own vault is excluded", () => {
  const events: HistoryEvent[] = [
    init("first.testnet"),
    { ...at(NOW - 60 * HOUR), kind: "sold", seller: "first.testnet", buyer: "seller.testnet", price: "1", epoch: 2 },
    { ...at(NOW - 60 * HOUR), kind: "owner", previous: "first.testnet", owner: "seller.testnet", epoch: 2 },
    ...honest().slice(1),
    deposit(NOW - 20 * HOUR, "first.testnet"),
    deposit(NOW - 20 * HOUR, "seller.testnet"),
    charge(NOW - 10 * HOUR, ["first.testnet", 500_000], ["seller.testnet", 500_000], [VAULT, 1]),
  ];
  assert.deepEqual(ownersFromEvents(events).sort(), ["first.testnet", "seller.testnet"]);
  const a = appraise(input(events, { "a.testnet": clean, "b.testnet": clean, "c.testnet": clean }, { ownerEpoch: 2 }), STRICT_POLICY);
  assert.equal(a.excluded.owner, 1_000_001n);
  assert.equal(a.independentRevenue, 50_000n);
  assert.ok(a.checks.every((c) => c.ok), "the honest customers still pass");
  assert.equal(a.customers.find((c) => c.customer === "first.testnet")!.class, "owner");
});

test("appraisal: customers funded by the owner are excluded (deposit_for, transfers, sub-accounts)", () => {
  const events: HistoryEvent[] = [
    init("seller.testnet"),
    deposit(NOW - 20 * HOUR, "w1.testnet"),
    deposit(NOW - 20 * HOUR, "w2.testnet", "seller.testnet"),
    deposit(NOW - 20 * HOUR, "c1.seller.testnet"),
    charge(NOW - 10 * HOUR, ["w1.testnet", 300_000], ["w2.testnet", 300_000], ["c1.seller.testnet", 300_000]),
  ];
  const fundedByOwner: FundingRecord = { funders: [{ account: "seller.testnet", tx: "T9", how: "sent 5000000 of tusdc.testnet" }], complete: true };
  const a = appraise(input(events, { "w1.testnet": fundedByOwner, "w2.testnet": clean, "c1.seller.testnet": clean }, { revenue30d: 900_000n }), DEMO_POLICY);
  assert.equal(a.independentRevenue, 0n);
  assert.equal(a.excluded.ownerFunded, 900_000n);
  assert.deepEqual(a.customers.map((c) => c.class), ["owner-funded", "owner-funded", "owner-funded"]);
  const gate = check(a, "independent paying customers");
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /revenue from owner-funded customers excluded/);
  assert.match(gate.detail, /w2\.testnet: credit deposited by seller\.testnet \(deposit_for\)/);
  assert.match(gate.detail, /c1\.seller\.testnet: sub-account of seller\.testnet/);
  assert.match(gate.detail, /w1\.testnet: funded by seller\.testnet/);
});

test("appraisal: unverified funding, unattributed revenue and sponsors", () => {
  const events: HistoryEvent[] = [
    init("seller.testnet"),
    deposit(NOW - 20 * HOUR, "a.testnet"),
    deposit(NOW - 20 * HOUR, "b.testnet", "sponsor.testnet"),
    deposit(NOW - 20 * HOUR, "c.testnet", "sponsor.testnet"),
    deposit(NOW - 20 * HOUR, "d.testnet"),
    charge(NOW - 10 * HOUR, ["a.testnet", 100], ["b.testnet", 100], ["c.testnet", 100], ["d.testnet", 100]),
    charge(NOW - 40 * 24 * HOUR, ["a.testnet", 999_999]),
  ];
  const a = appraise(input(events, { "a.testnet": clean, "b.testnet": clean, "c.testnet": clean, "d.testnet": { funders: [], complete: false } }, { revenue30d: 1_000n }), STRICT_POLICY);
  assert.equal(a.customers.find((c) => c.customer === "d.testnet")!.class, "unverified");
  assert.equal(a.excluded.unverified, 100n);
  assert.equal(a.excluded.unattributed, 600n, "revenue the vault reports but no event explains");
  assert.equal(a.independentRevenue, 300n, "charges older than 30 days do not count");
  assert.deepEqual(a.payers.map((p) => [p.payer, p.customers.length]), [["sponsor.testnet", 2], ["a.testnet", 1]], "two customers of one sponsor are one payer");
  assert.equal(check(a, "independent paying customers").ok, false);
});

test("appraisal: a missing ownership epoch fails the owner check", () => {
  const a = appraise(input(honest().slice(1), { "a.testnet": clean, "b.testnet": clean, "c.testnet": clean }, { ownerEpoch: 2 }), STRICT_POLICY);
  assert.equal(check(a, "every owner known").ok, false);
  assert.throws(() => policyByName("lenient"), /unknown policy/);
  assert.equal(policyByName("demo").minCustomers, 2);
});

test("appraisal: vault_charge and vault_deposit logs carry customer, cost and sender", () => {
  const evt = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "outlive", version: "1.0.0", event, data: [data] })}`;
  const tx: IndexedTransaction = {
    transaction: { hash: "T1", signer_id: "w.testnet", receiver_id: VAULT },
    receipts: [
      {
        receipt: { receipt_id: "r1", receiver_id: VAULT, predecessor_id: TOKEN },
        execution_outcome: { block_height: 1, block_timestamp: String(NOW * 1_000_000), index: 0, id: "o1", outcome: { logs: [evt("vault_deposit", { customer: "x.testnet", sender: "seller.testnet", amount: "5000000" })], executor_id: VAULT, status: { SuccessValue: "" } } },
      },
      {
        receipt: { receipt_id: "r2", receiver_id: VAULT, predecessor_id: VAULT },
        execution_outcome: { block_height: 2, block_timestamp: String(NOW * 1_000_000), index: 0, id: "o2", outcome: { logs: [evt("vault_charge", { earned: "10", items: [{ customer: "x.testnet", units: 1, cost: "10", status: "charged" }, { customer: "y.testnet", units: 1, cost: "0", status: "duplicate" }] })], executor_id: VAULT, status: { SuccessValue: "" } } },
      },
    ],
  };
  const events = eventsFromTransactions([tx], VAULT);
  assert.deepEqual(events.map((e) => e.kind), ["deposit", "charge"]);
  const d = events[0] as Extract<HistoryEvent, { kind: "deposit" }>;
  assert.deepEqual([d.customer, d.sender, d.amount], ["x.testnet", "seller.testnet", "5000000"]);
  assert.deepEqual([...revenueByCustomer(events, 0).entries()], [["x.testnet", { revenue: 10n, calls: 1 }]]);
});

test("funding read: only transactions the customer did not sign are read; owner transfers are found", async () => {
  const transfer = (from: string, to: string): IndexedTransaction => ({
    transaction: { hash: `T-${from}`, signer_id: from, receiver_id: TOKEN },
    receipts: [
      {
        receipt: { receipt_id: "r", receiver_id: TOKEN, predecessor_id: from },
        execution_outcome: { block_height: 1, block_timestamp: "1", index: 0, id: `o-${from}`, outcome: { logs: [`EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: from, new_owner_id: to, amount: "7" }] })}`], executor_id: TOKEN, status: { SuccessValue: "" } } },
      },
    ],
  });
  const asked: string[][] = [];
  const fetchFn: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body) as { tx_hashes?: string[] };
    if (url.endsWith("/v0/account")) {
      const txs = [
        { transaction_hash: "T-mine", tx_block_height: 1, tx_block_timestamp: "1", is_signer: true, is_event_log: false },
        { transaction_hash: "T-seller.testnet", tx_block_height: 2, tx_block_timestamp: "2", is_signer: false, is_event_log: true },
      ];
      return { ok: true, status: 200, json: async () => ({ account_txs: txs, txs_count: 2 }) };
    }
    asked.push(body.tx_hashes!);
    return { ok: true, status: 200, json: async () => ({ transactions: [transfer("seller.testnet", "w1.testnet")] }) };
  };
  const r = await readFunding(new TxIndex("https://index.test", fetchFn), "w1.testnet", TOKEN);
  assert.deepEqual(asked, [["T-seller.testnet"]]);
  assert.equal(r.complete, true);
  assert.deepEqual(r.funders.map((f) => f.account), ["seller.testnet", "seller.testnet"]);
  assert.deepEqual(inboundTransfers([transfer("seller.testnet", "w1.testnet")], "other.testnet", "w1.testnet"), [], "another token is ignored");
});

test("demo-account labels: the project's own traffic agents and seller-funded accounts", () => {
  assert.equal(isProjectDemoAccount("outlive-alice.testnet"), true);
  assert.equal(isProjectDemoAccount("wash1.outlive-seller.testnet"), true);
  assert.equal(isProjectDemoAccount("someone.testnet", ["outlive-seller2.testnet"]), true);
  assert.equal(isProjectDemoAccount("someone.testnet", ["someone.testnet"]), false);
});
