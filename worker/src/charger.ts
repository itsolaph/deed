// Charging: one charge item per accepted delivery, batched and signed as the vault with the
// worker key. Pre-accounting keeps the worker from accepting more than a customer's balance
// and daily cap allow while charges are not flushed yet.
//
// For each customer the worker keeps the last chain view and three lists of charges that view
// does not include yet: `pending` (not sent), `inFlight` (in the current charge transaction)
// and `unseen` (confirmed, but the view was read before). What it may still accept is
// chargeable_today(view) minus the cost of those three lists.

import type { ChargeItem, CustomerView } from "@deed/sdk";
import type { VaultChain } from "./vault-chain.js";

export const MAX_BATCH = 40;
export const VIEW_MAX_AGE_MS = 30_000;
const MAX_SEQ_RETRIES = 3;

export type RefusalReason = "unknown_customer" | "insufficient_balance" | "daily_cap_reached" | "refund_pending";

export interface PendingCharge {
  id: string;
  customer: string;
  seq: number;
  cost: bigint;
  receiptsRoot: string;
  retries: number;
  confirmedAt?: number;
}

interface Account {
  view: CustomerView | null;
  fetchedAt: number;
  loading: Promise<void> | null;
  /** Highest seq handed out (or seen on chain). */
  lastAssigned: number;
  /** Chain last_seq when this worker first saw the customer; older seqs were charged before. */
  floor: number | null;
  pending: PendingCharge[];
  inFlight: PendingCharge[];
  unseen: PendingCharge[];
}

export interface ChargerHooks {
  /** A charge was confirmed (status "charged" or "duplicate") or refused for good. */
  onSettled(item: PendingCharge, status: string, tx: string | undefined): void;
  /** A pending charge got a new seq (after a seq gap); the receipt must be re-issued. */
  onReseq(item: PendingCharge): string;
  /** First chain view of a customer: the handover floor. */
  onFloor(customer: string, seq: number): void;
  /** The whole charge transaction failed. */
  onBatchFailed(error: string): void;
  log(line: string): void;
}

function sum(items: PendingCharge[]): bigint {
  return items.reduce((n, i) => n + i.cost, 0n);
}

export class Charger {
  private readonly accounts = new Map<string, Account>();
  private flushing: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly chain: Pick<VaultChain, "customer" | "charge">,
    private readonly hooks: ChargerHooks,
    private readonly now: () => number = Date.now,
  ) {}

  private account(customer: string): Account {
    let a = this.accounts.get(customer);
    if (!a) {
      a = { view: null, fetchedAt: 0, loading: null, lastAssigned: 0, floor: null, pending: [], inFlight: [], unseen: [] };
      this.accounts.set(customer, a);
    }
    return a;
  }

  /** Restores state from the journal before the first chain read. */
  restore(customer: string, opts: { floor?: number; pending?: PendingCharge[]; maxSeq?: number }): void {
    const a = this.account(customer);
    if (opts.floor !== undefined) a.floor = opts.floor;
    if (opts.pending) a.pending.push(...opts.pending);
    if (opts.maxSeq !== undefined) a.lastAssigned = Math.max(a.lastAssigned, opts.maxSeq);
  }

  private refresh(customer: string, force = false): Promise<void> {
    const a = this.account(customer);
    if (a.loading) return a.loading;
    // While a charge is in flight the chain may or may not include it; keep the old view.
    if (a.inFlight.length > 0) return Promise.resolve();
    if (!force && a.view && this.now() - a.fetchedAt < VIEW_MAX_AGE_MS) return Promise.resolve();
    const startedAt = this.now();
    a.loading = this.chain
      .customer(customer)
      .then((view) => {
        a.view = view;
        a.fetchedAt = startedAt;
        a.unseen = a.unseen.filter((i) => (i.confirmedAt ?? 0) > startedAt);
        if (view) {
          const lastSeq = Number(view.last_seq);
          if (a.floor === null) {
            a.floor = lastSeq;
            this.hooks.onFloor(customer, lastSeq);
          }
          a.lastAssigned = Math.max(a.lastAssigned, lastSeq);
        }
      })
      .finally(() => {
        a.loading = null;
      });
    return a.loading;
  }

  /** Chain seq at first contact. Seqs at or below it were charged before this worker. */
  async floorOf(customer: string): Promise<number | null> {
    const a = this.account(customer);
    if (a.floor === null) await this.refresh(customer, true);
    return a.floor;
  }

  /** What the customer can still be charged today, minus everything not yet on chain. */
  available(customer: string): { balance: bigint; capLeft: bigint } | null {
    const a = this.account(customer);
    if (!a.view) return null;
    const reserved = sum(a.pending) + sum(a.inFlight) + sum(a.unseen);
    const v = a.view;
    const balance = BigInt(v.balance) - reserved;
    let capLeft = BigInt(v.chargeable_today) - reserved;
    // A scheduled cap decrease: plan with the lower cap already.
    if (v.pending_daily_cap !== null) {
      const lower = BigInt(v.pending_daily_cap) - BigInt(v.spent_today) - reserved;
      if (lower < capLeft) capLeft = lower;
    }
    return { balance, capLeft };
  }

  /**
   * Reserves one charge of `price` for `customer` and hands out its seq. `make` turns the
   * seq into the delivery id and receipts root; it runs synchronously, so no other admission
   * can take the same seq.
   */
  async admit(customer: string, price: bigint, make: (seq: number) => { id: string; receiptsRoot: string }): Promise<{ ok: true; item: PendingCharge } | { ok: false; reason: RefusalReason; balance: bigint }> {
    if (this.stopped) throw new Error("charger stopped");
    await this.refresh(customer);
    const a = this.account(customer);
    if (!a.view) return { ok: false, reason: "unknown_customer", balance: 0n };
    if (a.view.refund_requested_at_ms !== null) return { ok: false, reason: "refund_pending", balance: BigInt(a.view.balance) };
    const room = this.available(customer)!;
    if (room.balance < price) return { ok: false, reason: "insufficient_balance", balance: room.balance };
    if (room.capLeft < price) return { ok: false, reason: "daily_cap_reached", balance: room.balance };
    const seq = a.lastAssigned + 1;
    a.lastAssigned = seq;
    const { id, receiptsRoot } = make(seq);
    const item: PendingCharge = { id, customer, seq, cost: price, receiptsRoot, retries: 0 };
    a.pending.push(item);
    return { ok: true, item };
  }

  pendingCount(): number {
    let n = 0;
    for (const a of this.accounts.values()) n += a.pending.length + a.inFlight.length;
    return n;
  }

  /** Re-reads every customer that has nothing in flight (deposits, refund requests). */
  async refreshAll(): Promise<void> {
    await Promise.all([...this.accounts.keys()].map((c) => this.refresh(c).catch(() => undefined)));
  }

  /** Sends one batch. Calls made while a flush runs wait for it. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private takeBatch(): PendingCharge[] {
    const batch: PendingCharge[] = [];
    for (const a of this.accounts.values()) {
      a.pending.sort((x, y) => x.seq - y.seq);
      while (a.pending.length > 0 && batch.length < MAX_BATCH) {
        const item = a.pending.shift()!;
        a.inFlight.push(item);
        batch.push(item);
      }
      if (batch.length >= MAX_BATCH) break;
    }
    return batch;
  }

  private async flushOnce(): Promise<void> {
    if (this.stopped) return;
    const batch = this.takeBatch();
    if (batch.length === 0) return;
    const items: ChargeItem[] = batch.map((i) => ({ customer: i.customer, seq: i.seq, units: 1, receipts_root: i.receiptsRoot }));
    const out = await this.chain.charge(items);
    const touched = new Set(batch.map((i) => i.customer));

    if (!out.ok) {
      for (const c of touched) {
        const a = this.account(c);
        a.pending.unshift(...a.inFlight);
        a.inFlight = [];
      }
      this.hooks.onBatchFailed(out.error ?? "charge failed");
      return;
    }

    const now = this.now();
    const regap = new Set<string>();
    for (const item of batch) {
      const a = this.account(item.customer);
      a.inFlight = a.inFlight.filter((i) => i !== item);
      const r = out.results.find((x) => x.customer === item.customer && x.seq === item.seq);
      const status = r?.status ?? "missing_result";
      if (status === "charged" || status === "duplicate") {
        item.confirmedAt = now;
        if (status === "charged") a.unseen.push(item);
        this.hooks.onSettled(item, status, out.hash);
      } else if (status === "seq_gap" && item.retries < MAX_SEQ_RETRIES) {
        item.retries += 1;
        a.pending.push(item);
        regap.add(item.customer);
      } else {
        this.hooks.onSettled(item, status, out.hash);
        this.hooks.log(`charge ${item.id} for ${item.customer} seq ${item.seq} refused: ${status} (delivery stays owed, unpaid)`);
        regap.add(item.customer);
      }
    }

    const chargedCount = out.results.filter((r) => r.status === "charged").length;
    this.hooks.log(`charge tx ${out.hash ?? "?"}: ${chargedCount} of ${batch.length} items charged`);
    await Promise.all([...touched].map((c) => this.refresh(c, true).catch(() => undefined)));
    for (const c of regap) this.renumber(c);
  }

  /** After a gap or a refused item: give the pending charges fresh seqs after the chain's. */
  private renumber(customer: string): void {
    const a = this.account(customer);
    if (!a.view) return;
    let seq = Number(a.view.last_seq);
    a.pending.sort((x, y) => x.seq - y.seq);
    for (const item of a.pending) {
      seq += 1;
      if (item.seq !== seq) {
        item.seq = seq;
        item.receiptsRoot = this.hooks.onReseq(item);
      }
    }
    a.lastAssigned = seq;
  }

  /** Stops charging for good (handover). Returns what was never sent. */
  stop(): PendingCharge[] {
    this.stopped = true;
    const left: PendingCharge[] = [];
    for (const a of this.accounts.values()) {
      left.push(...a.pending, ...a.inFlight);
      a.pending = [];
    }
    return left;
  }

  get isStopped(): boolean {
    return this.stopped;
  }
}
