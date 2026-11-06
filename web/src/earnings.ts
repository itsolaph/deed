// Earnings history per vault: read lazily (only when someone opens a outlive), cached in memory and
// localStorage, never on the 30 s refresh loop. The parsing lives in sdk/src/history.ts.

import { buildEarningsHistory, readVaultHistory, TxIndex, type EarningsHistory, type HistoryEvent } from "../../sdk/src/history.js";
import { TX_INDEX } from "./config";

/** A read younger than this is shown as is: opening the outlive again costs no request. */
const TTL_MS = 120_000;
/** "Read again" waits at least this long after the previous read. */
const MIN_GAP_MS = 10_000;
/** Transaction batches per open (20 each): 1 list request + at most 3 batch requests. */
const MAX_BATCHES = 3;
// v2: charge events carry per-customer items, deposits are kept (older caches lack both).
const STORE = (vault: string) => `outlive.history.v2.${vault}`;

interface Cached {
  events: HistoryEvent[];
  settled: string[];
  readAt: number;
  listed: number;
  unread: number;
}

export interface HistoryState {
  status: "loading" | "ok" | "error";
  history: EarningsHistory | null;
  /** The raw events behind it (charges per customer, deposits), for the customer list. */
  events: HistoryEvent[];
  /** When the last successful read finished, or 0. */
  readAt: number;
  listed: number;
  unread: number;
  /** Requests the last read made. */
  requests: number;
  error: string | null;
}

const index = new TxIndex(TX_INDEX);
const cache = new Map<string, Cached>();
const states = new Map<string, HistoryState>();
const inFlight = new Set<string>();
const listeners = new Set<(vault: string) => void>();

function load(vault: string): Cached | null {
  const mem = cache.get(vault);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(STORE(vault));
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!Array.isArray(c.events) || !Array.isArray(c.settled)) return null;
    cache.set(vault, c);
    return c;
  } catch {
    return null;
  }
}

function save(vault: string, c: Cached): void {
  cache.set(vault, c);
  try {
    localStorage.setItem(STORE(vault), JSON.stringify(c));
  } catch {
    // private mode or full: memory still holds it
  }
}

function set(vault: string, s: HistoryState): void {
  states.set(vault, s);
  for (const fn of listeners) fn(vault);
}

const fromCache = (vault: string, c: Cached, status: HistoryState["status"], extra: Partial<HistoryState> = {}): HistoryState => ({
  status,
  history: buildEarningsHistory(c.events, vault),
  events: c.events,
  readAt: c.readAt,
  listed: c.listed,
  unread: c.unread,
  requests: 0,
  error: null,
  ...extra,
});

export function historyState(vault: string): HistoryState | null {
  const s = states.get(vault);
  if (s) return s;
  const c = load(vault);
  return c ? fromCache(vault, c, "ok") : null;
}

export function onHistory(fn: (vault: string) => void): void {
  listeners.add(fn);
}

/** Opening a outlive calls this. A fresh cache costs nothing; otherwise one list request plus the
 *  unsettled transactions (usually none or one batch). `force` is the "Read again" button. */
export function wantHistory(vault: string, force = false): void {
  if (inFlight.has(vault)) return;
  const c = load(vault);
  const age = c ? Date.now() - c.readAt : Infinity;
  if (c && (force ? age < MIN_GAP_MS : age < TTL_MS)) {
    if (!states.has(vault)) set(vault, fromCache(vault, c, "ok"));
    return;
  }
  inFlight.add(vault);
  set(vault, c ? fromCache(vault, c, "loading") : { status: "loading", history: null, events: [], readAt: 0, listed: 0, unread: 0, requests: 0, error: null });
  void readVaultHistory(index, vault, c ?? undefined, { maxBatches: MAX_BATCHES })
    .then((r) => {
      const next: Cached = { events: r.events, settled: r.settled, readAt: Date.now(), listed: r.listed, unread: r.unread };
      save(vault, next);
      set(vault, fromCache(vault, next, "ok", { requests: r.requests }));
    })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // A cached read stays on screen; the error is shown next to it.
      set(vault, c ? fromCache(vault, c, "error", { error: msg }) : { status: "error", history: null, events: [], readAt: 0, listed: 0, unread: 0, requests: 0, error: msg });
    })
    .finally(() => inFlight.delete(vault));
}

export const canReadAgain = (s: HistoryState | null): boolean => !s || (s.status !== "loading" && Date.now() - s.readAt >= MIN_GAP_MS);
