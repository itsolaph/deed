// Earnings history of a vault, per ownership epoch, from the NEP-297 events the vault and outlive
// contracts already emit. Browser-safe. No contract state is read here: the events are the record.
//
// Source: FastNEAR's transaction index (tx.test.fastnear.com): `POST /v0/account` lists every
// transaction that touched an account, `POST /v0/transactions` returns up to 20 of them with every
// receipt and its logs. NearBlocks has the same data in principle, but its testnet indexer can lag
// by weeks, and its account endpoints return no logs.
//
// Events used (contracts/vault/src, contracts/outlive/src):
//   vault_init      {owner_id, owner_epoch: 1}                   opens epoch 1 (the mint)
//   vault_owner     {previous, owner_id, epoch}                  opens a new epoch (sale or transfer)
//   vault_charge    {price, earned, items[{customer, units, cost, status}]} paid calls and revenue
//   vault_deposit   {customer, sender, amount}                   customer credit and who paid it in
//   vault_withdraw  {receiver_id, amount, owner_epoch}           a payout, tagged with its epoch
//   outlive_sold       {token_id, seller, buyer, price, epoch}      the sale that opened `epoch`
// Logs of failed receipts are ignored: NEAR keeps them, but their state changes were rolled back.

export const TESTNET_TX_API = "https://tx.test.fastnear.com";
export const MAINNET_TX_API = "https://tx.main.fastnear.com";
/** `/v0/transactions` refuses more than 20 hashes per request. */
export const TX_BATCH_LIMIT = 20;

// ---------------------------------------------------------------- raw index shapes (the fields used)

export interface IndexedAccountTx {
  transaction_hash: string;
  tx_block_height: number;
  /** Nanoseconds, as a decimal string. */
  tx_block_timestamp: string;
  /** The account signed the transaction. */
  is_signer?: boolean;
  /** The account only appears in an event log of the transaction (for example as a token receiver). */
  is_event_log?: boolean;
}

export interface IndexedOutcome {
  block_height: number;
  block_timestamp: number | string;
  /** Position of the outcome in its chunk: orders receipts of one account inside a block. */
  index: number;
  id: string;
  outcome: {
    logs: string[];
    executor_id: string;
    status: Record<string, unknown>;
  };
}

export interface IndexedTransaction {
  transaction: { hash: string; signer_id: string; receiver_id: string };
  receipts: { receipt: { receipt_id: string; receiver_id: string; predecessor_id: string }; execution_outcome: IndexedOutcome }[];
}

// ---------------------------------------------------------------- events

interface EventBase {
  tx: string;
  blockHeight: number;
  /** Outcome index in the chunk, then log index: a total order for one account's receipts. */
  order: number;
  logIndex: number;
  atMs: number;
}

export type HistoryEvent =
  | (EventBase & { kind: "init"; owner: string; epoch: number })
  | (EventBase & { kind: "owner"; previous: string; owner: string; epoch: number })
  | (EventBase & { kind: "charge"; calls: number; earned: string; items?: ChargedItem[] })
  | (EventBase & { kind: "deposit"; customer: string; sender: string; amount: string })
  | (EventBase & { kind: "withdraw"; receiver: string; amount: string; epoch: number })
  | (EventBase & { kind: "sold"; seller: string; buyer: string; price: string; epoch: number });

/** One item of a `vault_charge` that moved money (status "charged"): who paid and how much. */
export interface ChargedItem {
  customer: string;
  units: number;
  cost: string;
}

export interface Nep297 {
  standard: string;
  version: string;
  event: string;
  data: unknown[];
}

/** Parses one log line `EVENT_JSON:{...}`, or returns null for anything else. */
export function parseEventLog(log: string): Nep297 | null {
  if (!log.startsWith("EVENT_JSON:")) return null;
  try {
    const e = JSON.parse(log.slice("EVENT_JSON:".length)) as Partial<Nep297>;
    if (typeof e.standard !== "string" || typeof e.event !== "string" || !Array.isArray(e.data)) return null;
    return { standard: e.standard, version: String(e.version ?? ""), event: e.event, data: e.data };
  } catch {
    return null;
  }
}

const isSuccess = (status: Record<string, unknown>): boolean => "SuccessValue" in status || "SuccessReceiptId" in status;
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : NaN);
const nsToMs = (ns: number | string): number => Number(BigInt(String(ns)) / 1_000_000n);

/** The outlive account is the parent of the vault account: `<token>.<outlive>`. */
export function vaultParts(vault: string): { tokenId: string; outlive: string } {
  const dot = vault.indexOf(".");
  return { tokenId: vault.slice(0, dot), outlive: vault.slice(dot + 1) };
}

/** Extracts the events that make up a vault's earnings history from indexed transactions:
 *  vault events executed by the vault itself, and `outlive_sold` for this vault's token executed by
 *  its outlive. Unknown or malformed events are skipped. The result is in chain order. */
export function eventsFromTransactions(txs: IndexedTransaction[], vault: string): HistoryEvent[] {
  const { tokenId, outlive } = vaultParts(vault);
  const out: HistoryEvent[] = [];
  const seen = new Set<string>();
  for (const tx of txs) {
    for (const r of tx.receipts) {
      const o = r.execution_outcome;
      const executor = o.outcome.executor_id || r.receipt.receiver_id;
      if (executor !== vault && executor !== outlive) continue;
      if (!isSuccess(o.outcome.status)) continue;
      o.outcome.logs.forEach((log, logIndex) => {
        const e = parseEventLog(log);
        if (!e || e.standard !== "outlive") return;
        const d = (e.data[0] ?? {}) as Record<string, unknown>;
        const key = `${o.id}:${logIndex}`;
        if (seen.has(key)) return;
        const base: EventBase = { tx: tx.transaction.hash, blockHeight: o.block_height, order: o.index, logIndex, atMs: nsToMs(o.block_timestamp) };
        let ev: HistoryEvent | null = null;
        if (executor === vault) {
          if (e.event === "vault_init") ev = { ...base, kind: "init", owner: str(d.owner_id), epoch: num(d.owner_epoch) || 1 };
          else if (e.event === "vault_owner") ev = { ...base, kind: "owner", previous: str(d.previous), owner: str(d.owner_id), epoch: num(d.epoch) };
          else if (e.event === "vault_withdraw") ev = { ...base, kind: "withdraw", receiver: str(d.receiver_id), amount: str(d.amount), epoch: num(d.owner_epoch) };
          else if (e.event === "vault_charge") {
            const items = Array.isArray(d.items) ? (d.items as Record<string, unknown>[]) : [];
            const paid = items.filter((it) => str(it.cost) !== "" && BigInt(str(it.cost)) > 0n);
            const calls = paid.reduce((n, it) => n + (num(it.units) || 0), 0);
            const charged: ChargedItem[] = paid.map((it) => ({ customer: str(it.customer), units: num(it.units) || 0, cost: str(it.cost) }));
            ev = { ...base, kind: "charge", calls, earned: str(d.earned) || "0", items: charged };
          } else if (e.event === "vault_deposit") {
            ev = { ...base, kind: "deposit", customer: str(d.customer), sender: str(d.sender), amount: str(d.amount) || "0" };
          }
        } else if (e.event === "outlive_sold" && d.token_id === tokenId) {
          ev = { ...base, kind: "sold", seller: str(d.seller), buyer: str(d.buyer), price: str(d.price), epoch: num(d.epoch) };
        }
        if (ev) {
          seen.add(key);
          out.push(ev);
        }
      });
    }
  }
  return sortEvents(out);
}

export function sortEvents<T extends EventBase>(events: T[]): T[] {
  return [...events].sort((a, b) => a.blockHeight - b.blockHeight || a.order - b.order || a.logIndex - b.logIndex);
}

// ---------------------------------------------------------------- epochs

export interface TxRef {
  tx: string;
  atMs: number;
}

export interface Payout extends TxRef {
  receiver: string;
  amount: string;
}

export interface Epoch {
  epoch: number;
  /** The holder for this epoch; null when the event that opened it was not read. */
  holder: string | null;
  /** How the holder got the outlive: mint, sale, transfer, or unknown if the opening was not read. */
  openedBy: "mint" | "sale" | "transfer" | "unknown";
  /** The transaction that opened the epoch (the mint, sale or transfer), if read. */
  opened: TxRef | null;
  fromMs: number | null;
  /** null while the epoch is the current one. */
  toMs: number | null;
  /** Paid calls (units of charged items) and revenue earned in this epoch, smallest units. */
  calls: number;
  revenue: string;
  /** Payouts to the holder (vault_withdraw tagged with this epoch). */
  withdrawn: string;
  payouts: Payout[];
  chargeTxs: TxRef[];
  /** How the epoch ended: the sale (with price and buyer) or a transfer; null while current. */
  ended: null | { by: "sale"; price: string; buyer: string; tx: string; atMs: number } | { by: "transfer"; to: string; tx: string; atMs: number };
  /** Vault cash taken over at the start (left by the previous holder), and left at the end. Exact only when every earlier event was read. */
  cashIn: string;
  cashOut: string;
}

export interface EarningsHistory {
  vault: string;
  /** Newest epoch first. */
  epochs: Epoch[];
  totals: { holders: number; epochs: number; calls: number; revenue: string; withdrawn: string; sales: number; salesVolume: string };
  /** True when the mint (vault_init) was read, so epoch 1 starts at the beginning. */
  fromMint: boolean;
  /** Time of the newest event read, or null. */
  lastEventMs: number | null;
}

function blankEpoch(epoch: number, holder: string | null, openedBy: Epoch["openedBy"], opened: TxRef | null, cashIn: bigint): Epoch {
  return {
    epoch,
    holder,
    openedBy,
    opened,
    fromMs: opened?.atMs ?? null,
    toMs: null,
    calls: 0,
    revenue: "0",
    withdrawn: "0",
    payouts: [],
    chargeTxs: [],
    ended: null,
    cashIn: cashIn.toString(),
    cashOut: cashIn.toString(),
  };
}

/** Folds events (any order) into one row per ownership epoch. Charges belong to the epoch that
 *  was current on the vault when they executed; payouts carry their epoch explicitly. */
export function buildEarningsHistory(events: HistoryEvent[], vault: string): EarningsHistory {
  const evs = sortEvents(events);
  const sales = new Map<number, Extract<HistoryEvent, { kind: "sold" }>>();
  for (const e of evs) if (e.kind === "sold") sales.set(e.epoch, e);

  const epochs = new Map<number, Epoch>();
  const acc = new Map<number, { revenue: bigint; withdrawn: bigint }>();
  let current: Epoch | null = null;
  let fromMint = false;

  const open = (ep: Epoch): Epoch => {
    epochs.set(ep.epoch, ep);
    acc.set(ep.epoch, { revenue: 0n, withdrawn: 0n });
    return ep;
  };
  const cashOf = (ep: Epoch): bigint => {
    const a = acc.get(ep.epoch)!;
    return BigInt(ep.cashIn) + a.revenue - a.withdrawn;
  };
  /** The epoch charges and payouts go to when no opening event was read for it. */
  const ensure = (epoch: number): Epoch => epochs.get(epoch) ?? open(blankEpoch(epoch, null, "unknown", null, 0n));
  /** Charges read before any opening event belong to the epoch the first opening implies. */
  const firstEpoch = ((): number => {
    for (const e of evs) {
      if (e.kind === "init") return e.epoch;
      if (e.kind === "owner") return Math.max(1, e.epoch - 1);
      if (e.kind === "withdraw" && e.epoch > 0) return e.epoch;
    }
    return 1;
  })();

  for (const e of evs) {
    if (e.kind === "init") {
      fromMint = true;
      current = epochs.get(e.epoch) ?? open(blankEpoch(e.epoch, e.owner, "mint", { tx: e.tx, atMs: e.atMs }, 0n));
      current.holder = e.owner;
      current.openedBy = "mint";
      current.opened = { tx: e.tx, atMs: e.atMs };
      current.fromMs = e.atMs;
    } else if (e.kind === "owner") {
      const prev = epochs.get(e.epoch - 1) ?? open(blankEpoch(e.epoch - 1, e.previous || null, "unknown", null, 0n));
      if (prev.holder === null && e.previous) prev.holder = e.previous;
      const sale = sales.get(e.epoch);
      prev.toMs = e.atMs;
      prev.ended = sale
        ? { by: "sale", price: sale.price, buyer: sale.buyer, tx: sale.tx, atMs: sale.atMs }
        : { by: "transfer", to: e.owner, tx: e.tx, atMs: e.atMs };
      const carried = cashOf(prev);
      const next = epochs.get(e.epoch) ?? open(blankEpoch(e.epoch, e.owner, sale ? "sale" : "transfer", { tx: e.tx, atMs: e.atMs }, carried));
      next.holder = e.owner;
      next.openedBy = sale ? "sale" : "transfer";
      next.opened = { tx: e.tx, atMs: e.atMs };
      next.fromMs = e.atMs;
      next.cashIn = carried.toString();
      current = next;
    } else if (e.kind === "charge") {
      // Charges before any opening event go to an epoch with an unknown start; fromMint reports the gap.
      const ep: Epoch = current ?? (current = ensure(firstEpoch));
      ep.calls += e.calls;
      acc.get(ep.epoch)!.revenue += BigInt(e.earned);
      ep.chargeTxs.push({ tx: e.tx, atMs: e.atMs });
    } else if (e.kind === "withdraw") {
      const ep: Epoch = Number.isFinite(e.epoch) && e.epoch > 0 ? ensure(e.epoch) : (current ?? ensure(firstEpoch));
      if (!current) current = ep;
      acc.get(ep.epoch)!.withdrawn += BigInt(e.amount);
      ep.payouts.push({ tx: e.tx, atMs: e.atMs, receiver: e.receiver, amount: e.amount });
    }
  }

  const list = [...epochs.values()].sort((a, b) => a.epoch - b.epoch);
  for (const ep of list) {
    const a = acc.get(ep.epoch)!;
    ep.revenue = a.revenue.toString();
    ep.withdrawn = a.withdrawn.toString();
    ep.cashOut = cashOf(ep).toString();
  }
  const sum = (f: (e: Epoch) => string) => list.reduce((n, e) => n + BigInt(f(e)), 0n).toString();
  const sold = list.filter((e) => e.ended?.by === "sale");
  return {
    vault,
    epochs: list.reverse(),
    totals: {
      holders: new Set(list.map((e) => e.holder).filter((h): h is string => h !== null)).size,
      epochs: list.length,
      calls: list.reduce((n, e) => n + e.calls, 0),
      revenue: sum((e) => e.revenue),
      withdrawn: sum((e) => e.withdrawn),
      sales: sold.length,
      salesVolume: sold.reduce((n, e) => n + BigInt(e.ended!.by === "sale" ? e.ended!.price : "0"), 0n).toString(),
    },
    fromMint,
    lastEventMs: evs.length > 0 ? evs[evs.length - 1]!.atMs : null,
  };
}

/** Compares the history with the vault's own all-time counters (get_stats, get_info). Equal
 *  figures mean every charge and payout was read; a shortfall usually means the newest
 *  transactions were not indexed yet. */
export function reconcile(
  h: EarningsHistory,
  live: { callsTotal: number; revenueTotal: string | bigint; cash: string | bigint; inFlight?: string | bigint },
): { calls: number; revenue: bigint; withdrawn: bigint; matches: boolean } {
  const paidOut = BigInt(live.revenueTotal) - BigInt(live.cash) - BigInt(live.inFlight ?? 0);
  const calls = live.callsTotal - h.totals.calls;
  const revenue = BigInt(live.revenueTotal) - BigInt(h.totals.revenue);
  const withdrawn = paidOut - BigInt(h.totals.withdrawn);
  return { calls, revenue, withdrawn, matches: calls === 0 && revenue === 0n && withdrawn === 0n };
}

// ---------------------------------------------------------------- reading the index

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export class TxIndexError extends Error {}

/** FastNEAR's transaction index. Every method is one HTTP request (plus one retry on HTTP 429). */
export class TxIndex {
  constructor(
    readonly baseUrl: string = TESTNET_TX_API,
    private readonly fetchFn: FetchLike = (u, i) => fetch(u, i),
    private readonly timeoutMs = 20_000,
  ) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (!res.ok) throw new TxIndexError(`${path} answered HTTP ${res.status}`);
      return (await res.json()) as T;
    }
  }

  /** Every transaction that touched `account`, newest first, and the index's total count. */
  async accountTxs(account: string): Promise<{ txs: IndexedAccountTx[]; count: number }> {
    const r = await this.post<{ account_txs?: IndexedAccountTx[]; txs_count?: number }>("/v0/account", { account_id: account, max_block_height: null });
    const txs = r.account_txs ?? [];
    return { txs, count: r.txs_count ?? txs.length };
  }

  /** Full transactions with receipts and logs, at most TX_BATCH_LIMIT per call. */
  async transactions(hashes: string[]): Promise<IndexedTransaction[]> {
    if (hashes.length > TX_BATCH_LIMIT) throw new TxIndexError(`at most ${TX_BATCH_LIMIT} hashes per request`);
    if (hashes.length === 0) return [];
    const r = await this.post<{ transactions?: IndexedTransaction[] }>("/v0/transactions", { tx_hashes: hashes });
    return r.transactions ?? [];
  }
}

export interface HistoryRead {
  /** Events of every transaction read, this time and before (pass the cache back in). */
  events: HistoryEvent[];
  /** Hashes whose events are final and need not be read again. */
  settled: string[];
  /** Transactions the index lists for the vault, and how many of them are still unread. */
  listed: number;
  unread: number;
  requests: number;
}

/**
 * Reads a vault's history incrementally: one request for the transaction list, then only the
 * transactions not settled in `known`, oldest first, in batches of 20, at most `maxBatches`.
 * Transactions younger than `settleMs` are read but not settled, because their callbacks
 * (a payout's on_withdraw, a sale's owner push) may still be executing.
 */
export async function readVaultHistory(
  index: TxIndex,
  vault: string,
  known: { events: HistoryEvent[]; settled: string[] } = { events: [], settled: [] },
  opts: { maxBatches?: number; settleMs?: number; nowMs?: number } = {},
): Promise<HistoryRead> {
  const maxBatches = opts.maxBatches ?? 3;
  const settleMs = opts.settleMs ?? 120_000;
  const now = opts.nowMs ?? Date.now();
  const settledSet = new Set(known.settled);
  const list = await index.accountTxs(vault);
  let requests = 1;
  const todo = list.txs.filter((t) => !settledSet.has(t.transaction_hash)).reverse(); // oldest first
  const batches: string[][] = [];
  for (let i = 0; i < todo.length; i += TX_BATCH_LIMIT) batches.push(todo.slice(i, i + TX_BATCH_LIMIT).map((t) => t.transaction_hash));
  const read = batches.slice(0, maxBatches);
  const fresh: IndexedTransaction[] = [];
  for (const b of read) {
    fresh.push(...(await index.transactions(b)));
    requests++;
  }
  const readHashes = new Set(read.flat());
  // Events of transactions read again are replaced by this read; the rest are kept as cached.
  const keep = known.events.filter((e) => !readHashes.has(e.tx));
  const events = sortEvents([...keep, ...eventsFromTransactions(fresh, vault)]);
  const young = new Set(list.txs.filter((t) => now - nsToMs(t.tx_block_timestamp) < settleMs).map((t) => t.transaction_hash));
  const settled = [...settledSet, ...[...readHashes].filter((h) => !young.has(h))];
  const unread = todo.length - readHashes.size + Math.max(0, list.count - list.txs.length);
  return { events, settled, listed: list.count, unread, requests };
}
