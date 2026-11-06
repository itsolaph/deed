// Appraisal of a vault's revenue for a buyer: which part of it can be attributed to independent
// customers. Browser-safe. The pure part (`appraise`) is unit tested; `readFunding` reads one
// customer's transactions from the same FastNEAR index the earnings history uses.
//
// What counts as independent revenue (window: the trailing 30 days):
//   - per-customer paid revenue from the vault's own `vault_charge` events (items with status
//     "charged"), so every amount is tied to the account it was charged to;
//   - excluded: revenue charged to the current owner, every previous owner (from the ownership
//     epochs), the listing seller, the vault and the outlive accounts;
//   - excluded: customers whose credit was funded by one of those accounts: a `vault_deposit`
//     whose sender is an excluded account (`deposit_for`), any transaction signed by an excluded
//     account that touches the customer account (NEAR or tUSDC transfers, account creation), a
//     NEP-141 transfer to the customer from an excluded account, or a customer account that is a
//     sub-account of an excluded account;
//   - excluded: customers whose funding history could not be read completely (unverified);
//   - excluded: revenue the vault reports (`get_stats`) that no charge event in the window
//     explains (not indexed yet, or older than the window edge).
// Credit paid in by a third party (`deposit_for` from someone who is neither the customer nor an
// excluded account) is counted under that sponsor: several customers funded by one sponsor are one
// payer for the distinct-customer count and the concentration check.
//
// Limits, stated: funding is followed one hop. An owner who funds a fresh account through an
// intermediary account is not caught. On testnet tUSDC can be minted by anyone, so a customer that
// minted its own tUSDC and got its NEAR from the faucet looks independent; that is what the demo
// traffic agents do.

import { parseEventLog, sortEvents, type HistoryEvent, type IndexedTransaction, type TxIndex, TX_BATCH_LIMIT } from "./history.js";
import { DAY_MS, STATS_WINDOW_DAYS } from "./payback.js";

export interface AppraisalPolicy {
  name: string;
  /** Distinct independent payers needed. */
  minCustomers: number;
  /** Largest share of independent revenue one payer may have (0..1). */
  maxShare: number;
  /** How long the vault must have existed. */
  minAgeHours: number;
}

export const STRICT_POLICY: AppraisalPolicy = { name: "strict", minCustomers: 3, maxShare: 0.6, minAgeHours: 72 };
export const DEMO_POLICY: AppraisalPolicy = { name: "demo", minCustomers: 2, maxShare: 0.8, minAgeHours: 0 };
export const DEMO_POLICY_NOTICE = "demo policy: thresholds relaxed for a 10-minute run";

export function policyByName(name: string): AppraisalPolicy {
  if (name === "strict") return { ...STRICT_POLICY };
  if (name === "demo") return { ...DEMO_POLICY };
  throw new Error(`unknown policy ${name} (strict or demo)`);
}

export function describePolicy(p: AppraisalPolicy): string {
  return `${p.name}: at least ${p.minCustomers} independent paying customers, none above ${Math.round(p.maxShare * 100)}% of independent revenue, vault at least ${p.minAgeHours} h old`;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** What one customer's funding history shows. */
export interface FundingRecord {
  /** Accounts (other than the customer) that signed a transaction touching the customer account,
   *  or sent it tokens. */
  funders: { account: string; tx: string; how: string }[];
  /** False when the index listed more transactions than were read. */
  complete: boolean;
}

export type CustomerClass = "independent" | "owner" | "owner-funded" | "unverified";

export interface CustomerAppraisal {
  customer: string;
  /** Whose money it is for the count and the share: the customer, or the sponsor that paid its credit in. */
  payer: string;
  calls: number;
  revenue: bigint;
  class: CustomerClass;
  reason: string;
}

export interface AppraisalInput {
  vault: string;
  outlive: string;
  /** Current vault owner. */
  owner: string;
  /** Further accounts to treat like owners (the listing seller). */
  alsoExcluded?: string[];
  /** Vault events from `eventsFromTransactions` (charges, deposits, ownership). */
  events: HistoryEvent[];
  /** Funding history per customer; a missing entry means it was not read. */
  funding: Map<string, FundingRecord>;
  /** `get_stats().revenue_30d`, to report revenue no event explains. */
  revenue30d: bigint;
  vaultCreatedAtMs: number;
  nowMs: number;
  /** The vault's current owner epoch: every epoch from 1 to this one must be in the events,
   *  or a previous owner could be missing from the exclusions. */
  ownerEpoch?: number;
}

export interface Appraisal {
  policy: AppraisalPolicy;
  /** Owners now and before, the listing seller, the vault and the outlive. */
  excludedAccounts: string[];
  customers: CustomerAppraisal[];
  /** Per independent payer, largest first. */
  payers: { payer: string; customers: string[]; revenue: bigint; share: number }[];
  independentRevenue: bigint;
  /** Revenue by reason it was not counted. */
  excluded: { owner: bigint; ownerFunded: bigint; unverified: bigint; unattributed: bigint };
  ageHours: number;
  checks: Check[];
}

/** Every account that held the outlive, from the ownership events (mint, owner changes, sales). */
export function ownersFromEvents(events: HistoryEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind === "init" && e.owner) out.add(e.owner);
    if (e.kind === "owner") {
      if (e.previous) out.add(e.previous);
      if (e.owner) out.add(e.owner);
    }
    if (e.kind === "sold") {
      if (e.seller) out.add(e.seller);
      if (e.buyer) out.add(e.buyer);
    }
  }
  return [...out];
}

/** Paid revenue and calls per customer in [fromMs, toMs], from `vault_charge` items. */
export function revenueByCustomer(events: HistoryEvent[], fromMs: number, toMs = Infinity): Map<string, { revenue: bigint; calls: number }> {
  const out = new Map<string, { revenue: bigint; calls: number }>();
  for (const e of events) {
    if (e.kind !== "charge" || e.atMs < fromMs || e.atMs > toMs) continue;
    for (const it of e.items ?? []) {
      if (!it.customer) continue;
      const row = out.get(it.customer) ?? { revenue: 0n, calls: 0 };
      row.revenue += BigInt(it.cost);
      row.calls += it.units;
      out.set(it.customer, row);
    }
  }
  return out;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const isSubAccountOf = (account: string, parent: string) => account.endsWith(`.${parent}`);

/** Pure: classifies every paying customer, sums independent revenue and runs the policy checks. */
export function appraise(input: AppraisalInput, policy: AppraisalPolicy): Appraisal {
  const events = sortEvents(input.events);
  const excludedSet = new Set<string>([input.owner, ...ownersFromEvents(events), ...(input.alsoExcluded ?? []), input.vault, input.outlive]);
  excludedSet.delete("");
  const excludedAccounts = [...excludedSet].sort();
  const fromMs = input.nowMs - STATS_WINDOW_DAYS * DAY_MS;
  const perCustomer = revenueByCustomer(events, fromMs, input.nowMs);

  // Deposits per customer: who paid the credit in.
  const deposits = new Map<string, { sender: string; amount: bigint }[]>();
  for (const e of events) {
    if (e.kind !== "deposit") continue;
    const list = deposits.get(e.customer) ?? [];
    list.push({ sender: e.sender, amount: BigInt(e.amount || "0") });
    deposits.set(e.customer, list);
  }

  const customers: CustomerAppraisal[] = [];
  for (const [customer, { revenue, calls }] of [...perCustomer.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const own = deposits.get(customer) ?? [];
    let cls: CustomerClass = "independent";
    let reason = "pays its own credit";
    let payer = customer;
    const parent = excludedAccounts.find((x) => isSubAccountOf(customer, x));
    const ownerDeposit = own.find((d) => d.sender !== customer && excludedSet.has(d.sender));
    const funding = input.funding.get(customer);
    const ownerFunder = funding?.funders.find((f) => excludedSet.has(f.account) && f.account !== input.vault && f.account !== input.outlive);
    if (excludedSet.has(customer)) {
      cls = "owner";
      reason = customer === input.vault || customer === input.outlive ? "the vault or the Outlive account itself" : "an owner (now or before) paying its own business";
    } else if (parent) {
      cls = "owner-funded";
      reason = `sub-account of ${parent}`;
    } else if (ownerDeposit) {
      cls = "owner-funded";
      reason = `credit deposited by ${ownerDeposit.sender} (deposit_for)`;
    } else if (ownerFunder) {
      cls = "owner-funded";
      reason = `funded by ${ownerFunder.account} (${ownerFunder.how}, tx ${ownerFunder.tx})`;
    } else if (!funding) {
      cls = "unverified";
      reason = "funding history not read";
    } else if (!funding.complete) {
      cls = "unverified";
      reason = "funding history not read completely";
    } else {
      const sponsor = own.filter((d) => d.sender !== customer).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))[0];
      if (sponsor) {
        payer = sponsor.sender;
        reason = `credit paid in by ${sponsor.sender}, counted under that payer`;
      }
    }
    customers.push({ customer, payer, calls, revenue, class: cls, reason });
  }

  const sum = (f: (c: CustomerAppraisal) => boolean) => customers.filter(f).reduce((n, c) => n + c.revenue, 0n);
  const independentRevenue = sum((c) => c.class === "independent");
  const attributed = sum(() => true);
  const unattributed = input.revenue30d > attributed ? input.revenue30d - attributed : 0n;

  const byPayer = new Map<string, { customers: string[]; revenue: bigint }>();
  for (const c of customers.filter((x) => x.class === "independent")) {
    const p = byPayer.get(c.payer) ?? { customers: [], revenue: 0n };
    p.customers.push(c.customer);
    p.revenue += c.revenue;
    byPayer.set(c.payer, p);
  }
  const payers = [...byPayer.entries()]
    .map(([payer, p]) => ({ payer, customers: p.customers, revenue: p.revenue, share: independentRevenue > 0n ? Number((p.revenue * 1_000_000n) / independentRevenue) / 1_000_000 : 0 }))
    .sort((a, b) => b.share - a.share);
  const excluded = {
    owner: sum((c) => c.class === "owner"),
    ownerFunded: sum((c) => c.class === "owner-funded"),
    unverified: sum((c) => c.class === "unverified"),
    unattributed,
  };
  const ageHours = Math.max(0, (input.nowMs - input.vaultCreatedAtMs) / 3_600_000);

  const counted = customers.filter((c) => c.class !== "independent");
  const why: string[] = [];
  if (excluded.ownerFunded > 0n) why.push("revenue from owner-funded customers excluded");
  if (excluded.owner > 0n) why.push("revenue from the owner's own accounts excluded");
  if (excluded.unverified > 0n) why.push("revenue from customers whose funding could not be checked excluded");
  const top = payers[0];
  const epochsSeen = new Set<number>();
  for (const e of events) {
    if (e.kind === "init") epochsSeen.add(e.epoch);
    if (e.kind === "owner") epochsSeen.add(e.epoch);
  }
  const wanted = input.ownerEpoch ?? Math.max(1, ...epochsSeen);
  const missing = Array.from({ length: wanted }, (_, i) => i + 1).filter((n) => !epochsSeen.has(n));
  const checks: Check[] = [
    {
      name: "every owner known",
      ok: missing.length === 0,
      detail: missing.length === 0 ? `${wanted} ownership epoch(s) read from the event log; excluded: ${excludedAccounts.join(", ")}` : `ownership epoch(s) ${missing.join(", ")} not in the event log read, so a previous owner could be missing`,
    },
    {
      name: "independent paying customers",
      ok: payers.length >= policy.minCustomers,
      detail:
        `${payers.length} independent of ${customers.length} paying customers, need ${policy.minCustomers}` +
        (counted.length > 0 ? `; ${why.join("; ")} (${counted.map((c) => `${c.customer}: ${c.reason}`).join("; ")})` : ""),
    },
    {
      name: "no single customer dominates",
      ok: payers.length > 0 && (top?.share ?? 1) <= policy.maxShare,
      detail: top ? `largest payer ${top.payer} has ${pct(top.share)} of independent revenue, limit ${pct(policy.maxShare)}` : "no independent revenue at all",
    },
    {
      name: "vault observed long enough",
      ok: ageHours >= policy.minAgeHours,
      detail: `vault is ${ageHours < 48 ? `${ageHours.toFixed(1)} h` : `${(ageHours / 24).toFixed(1)} days`} old, need ${policy.minAgeHours} h`,
    },
  ];
  return { policy, excludedAccounts, customers, payers, independentRevenue, excluded, ageHours, checks };
}

// ---------------------------------------------------------------- reading one customer's funding

/** NEP-141 `ft_transfer` events in `txs` that credited `account`, executed by `token`. */
export function inboundTransfers(txs: IndexedTransaction[], token: string, account: string): { from: string; amount: string; tx: string }[] {
  const out: { from: string; amount: string; tx: string }[] = [];
  for (const tx of txs) {
    for (const r of tx.receipts) {
      const o = r.execution_outcome;
      const executor = o.outcome.executor_id || r.receipt.receiver_id;
      if (executor !== token || !("SuccessValue" in o.outcome.status || "SuccessReceiptId" in o.outcome.status)) continue;
      for (const log of o.outcome.logs) {
        const e = parseEventLog(log);
        if (!e || e.standard !== "nep141" || e.event !== "ft_transfer") continue;
        for (const d of e.data as Record<string, unknown>[]) {
          if (d?.new_owner_id === account && typeof d.old_owner_id === "string") out.push({ from: d.old_owner_id, amount: String(d.amount ?? "0"), tx: tx.transaction.hash });
        }
      }
    }
  }
  return out;
}

/**
 * Reads the transactions of `customer` that it did not sign (the index flags them), and records
 * who touched the account: the signer of each such transaction and every NEP-141 sender on
 * `token`. At most `maxBatches` batches of 20; more means `complete: false`.
 */
export async function readFunding(index: TxIndex, customer: string, token: string, opts: { maxBatches?: number } = {}): Promise<FundingRecord & { requests: number }> {
  const maxBatches = opts.maxBatches ?? 3;
  const list = await index.accountTxs(customer);
  let requests = 1;
  const flagged = list.txs.every((t) => typeof t.is_signer === "boolean");
  const todo = (flagged ? list.txs.filter((t) => !t.is_signer) : list.txs).map((t) => t.transaction_hash);
  const funders: FundingRecord["funders"] = [];
  let read = 0;
  for (let i = 0; i < todo.length && i / TX_BATCH_LIMIT < maxBatches; i += TX_BATCH_LIMIT) {
    const batch = todo.slice(i, i + TX_BATCH_LIMIT);
    const txs = await index.transactions(batch);
    requests++;
    const returned = new Set(txs.map((tx) => tx.transaction.hash));
    read += batch.filter((hash) => returned.has(hash)).length;
    for (const tx of txs) {
      if (tx.transaction.signer_id !== customer) funders.push({ account: tx.transaction.signer_id, tx: tx.transaction.hash, how: "signed a transaction touching the account" });
    }
    for (const t of inboundTransfers(txs, token, customer)) {
      if (t.from !== customer) funders.push({ account: t.from, tx: t.tx, how: `sent ${t.amount} of ${token}` });
    }
  }
  const complete = read >= todo.length && list.count <= list.txs.length;
  return { funders, complete, requests };
}

/** Accounts the demo itself runs as customers (for labels only, never for the appraisal). */
export function isProjectDemoAccount(account: string, depositSenders: string[] = []): boolean {
  const seller = /^outlive-(seller\d*|hostile|wash)\.testnet$/;
  if (/^outlive-(alice|bob)\.testnet$/.test(account)) return true;
  if (seller.test(account)) return true;
  if (/^[a-z0-9-]+\.outlive-(seller\d*|hostile|wash)\.testnet$/.test(account)) return true;
  return depositSenders.some((s) => s !== account && seller.test(s));
}
