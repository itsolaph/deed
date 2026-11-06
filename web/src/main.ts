// Outlive web app: every token on the Outlive contract with live numbers from the contract views,
// its dynamic NFT certificate, and the actions for buyers, owners and customers.

import "./style.css";
import { Rpc, TESTNET_RPC_URLS } from "../../sdk/src/chain.js";
import { PAYBACK_LABEL, formatUnits, fromUnits, payback, toUnits, type PaybackResult } from "../../sdk/src/payback.js";
import { isProjectDemoAccount, ownersFromEvents } from "../../sdk/src/appraisal.js";
import { OutliveViews, VaultViews, type CustomerView, type OutliveView, type NftToken, type VaultInfo, type VaultStatsView } from "../../sdk/src/views.js";
import { reconcile, type Epoch } from "../../sdk/src/history.js";
import { OUTLIVE_CONTRACT, EXPLORER, NEAR_PRICE_USD, REFRESH_MS, TX_INDEX } from "./config";
import { canReadAgain, historyState, onHistory, wantHistory, type HistoryState } from "./earnings";
import { isHolder } from "./gate";
import { connect, currentAccount, disconnect, initWallet, onAccount, send, type Call } from "./wallet";

const rpc = new Rpc(TESTNET_RPC_URLS);
// Two orders of the same public endpoints: with free-tier limits of ~0.5 req/s each,
// alternating starts spreads the page's reads across both providers.
const rpcAlt = new Rpc([...TESTNET_RPC_URLS].reverse());
let rpcPicks = 0;
const pickRpc = (): Rpc => (rpcPicks++ % 2 === 0 ? rpc : rpcAlt);
const outliveViews = new OutliveViews(rpc, OUTLIVE_CONTRACT);
const ONE_YOCTO = 1n;
const NEAR = 10n ** 24n;

interface Row {
  outlive: OutliveView;
  info: VaultInfo;
  stats: VaultStatsView;
  token: NftToken | null;
  me: CustomerView | null;
}

let token = { contract: "", symbol: "tUSDC", decimals: 6 };
let rows: Row[] = [];
/** The tokens of the latest read (newest first, at most DETAIL_LIMIT): drives the tab counts. */
let outliveList: OutliveView[] = [];
let totalOutlives = 0;

// ---------------------------------------------------------------- tiny DOM helpers

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const $ = (id: string) => document.getElementById(id)!;
const amount = (v: string | bigint, digits = 4) => formatUnits(v, token.decimals, digits);
const near = (v: string | bigint, digits = 4) => formatUnits(v, 24, digits);
const short = (s: string | null, n = 10) => (s ? (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-6)}` : s) : "none");
const link = (path: string, text: string) => h("a", { href: `${EXPLORER}/${path}`, target: "_blank", rel: "noopener noreferrer" }, text);
/** The token ID people read on the board: the vault sub-account prefix, e.g. relay-1102fin2. */
const outliveId = (d: OutliveView) => d.vault_id.split(".")[0] || d.token_id;
const byCalls = (a: Row, b: Row) => b.stats.calls_30d - a.stats.calls_30d || b.stats.calls_total - a.stats.calls_total;

function status(text: string, kind: "info" | "ok" | "error" | "quiet" = "info", txHash?: string | null): void {
  const box = $("status");
  box.className = `status ${kind}`;
  box.replaceChildren(text, txHash ? " " : "", txHash ? link(`txns/${txHash}`, "view transaction") : "");
}

async function act(label: string, receiver: string, calls: Call[]): Promise<void> {
  try {
    status(`${label}: confirm in your wallet …`);
    const hash = await send(receiver, calls);
    status(`${label}: sent.`, "ok", hash);
    setTimeout(() => void refresh(true), 2500);
  } catch (e) {
    status(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

// ---------------------------------------------------------------- data

/** How many tokens get full detail (vault views) per load. Every extra token costs RPC calls
 *  against rate-limited public endpoints. */
const DETAIL_LIMIT = 12;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Free-tier 429s are bursty: a short backoff usually clears them. */
async function withBackoff<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await sleep(1200 * (i + 1));
    }
  }
  throw last;
}

async function fetchRow(outlive: OutliveView, me: string | null): Promise<Row> {
  const vault = new VaultViews(pickRpc(), outlive.vault_id);
  // Sequential on purpose: two providers at ~0.5 req/s each cannot absorb bursts.
  const info = await vault.info();
  await sleep(500);
  const stats = await vault.stats();
  const mine = me ? (await sleep(500), await vault.customer(me)) : null;
  return { outlive, info, stats, token: certCache.get(outlive.token_id) ?? null, me: mine };
}

/** What the page saw at each read of a token. Paid calls are only known per day on chain, but a
 *  rise in calls between two reads proves a paid call landed after the earlier read. */
interface Seen {
  calls30: number;
  callsTotal: number;
  readAt: number;
  /** A paid call landed after this time (the read before the rise), or null if none seen yet. */
  callAfter: number | null;
}
const seen = new Map<string, Seen>();
/** Rows whose 30-day calls rose in the latest read: flashed once by the next render. */
const flashKeys = new Set<string>();

function observe(r: Row): void {
  const key = r.outlive.token_id;
  const prev = seen.get(key);
  let callAfter = prev?.callAfter ?? null;
  if (prev && r.stats.calls_total > prev.callsTotal) callAfter = prev.readAt;
  if (prev && r.stats.calls_30d > prev.calls30) flashKeys.add(key);
  seen.set(key, { calls30: r.stats.calls_30d, callsTotal: r.stats.calls_total, readAt: Date.now(), callAfter });
}

/** Certificates survive refreshes: a token's metadata is fetched once per page life, and only
 *  for the tokens someone looks at (the featured one and opened rows). */
const certCache = new Map<string, NftToken>();
const certWanted: string[] = [];
let certBusy = false;

function wantCert(key: string): void {
  if (certCache.has(key) || certWanted.includes(key)) return;
  certWanted.push(key);
  void pumpCerts();
}

async function pumpCerts(): Promise<void> {
  if (certBusy) return;
  certBusy = true;
  try {
    while (certWanted.length > 0) {
      const key = certWanted.shift()!;
      if (certCache.has(key)) continue;
      try {
        const t = await withBackoff(() => outliveViews.token(key), 3);
        if (t) certCache.set(key, t);
        for (const r of rows) if (r.outlive.token_id === key) r.token = t;
        render();
      } catch {
        // keep the placeholder
      }
      await sleep(900);
    }
  } finally {
    certBusy = false;
  }
}

/** The token's owner as nft_token reports it. The token list can lag a transfer, so the holder
 *  console never trusts `outlive.owner_id`; it reads this view when a detail is opened. */
interface OwnerRead {
  status: "loading" | "ok" | "error";
  owner: string | null;
  error: string | null;
  readAt: number;
}

const OWNER_TTL_MS = 60_000;
const ownerReads = new Map<string, OwnerRead>();
const ownerWanted: string[] = [];
let ownerBusy = false;

function wantOwner(tokenId: string, force = false): void {
  const cur = ownerReads.get(tokenId);
  if (cur?.status === "loading") return;
  if (!force && cur && Date.now() - cur.readAt < OWNER_TTL_MS) return;
  ownerReads.set(tokenId, { status: "loading", owner: cur?.owner ?? null, error: null, readAt: Date.now() });
  if (!ownerWanted.includes(tokenId)) ownerWanted.push(tokenId);
  void pumpOwners();
}

async function pumpOwners(): Promise<void> {
  if (ownerBusy) return;
  ownerBusy = true;
  try {
    while (ownerWanted.length > 0) {
      const key = ownerWanted.shift()!;
      try {
        const t = await withBackoff(() => rpc.view<NftToken | null>(OUTLIVE_CONTRACT, "nft_token", { token_id: key }), 3);
        ownerReads.set(key, { status: "ok", owner: t?.owner_id ?? null, error: null, readAt: Date.now() });
      } catch (e) {
        ownerReads.set(key, { status: "error", owner: null, error: e instanceof Error ? e.message : String(e), readAt: Date.now() });
      }
      // The console is part of the row: repaint after the owner read, like a certificate.
      render();
      await sleep(400);
    }
  } finally {
    ownerBusy = false;
  }
}

/** Public testnet RPC is rate-limited: tokens are read one at a time. The first load paints
 *  rows as they arrive; later loads update rows in place, so the board never blanks. */
async function load(): Promise<void> {
  const live = document.getElementById("live");
  live?.removeAttribute("hidden");
  try {
    await loadInner();
  } finally {
    live?.setAttribute("hidden", "");
  }
}

async function loadInner(): Promise<void> {
  const config = await withBackoff(() => outliveViews.config());
  if (token.contract !== config.payment_token) {
    const meta = await withBackoff(() => rpc.view<{ symbol: string; decimals: number }>(config.payment_token, "ft_metadata"));
    token = { contract: config.payment_token, symbol: meta.symbol, decimals: meta.decimals };
  }
  const all = await withBackoff(() => outliveViews.tokens(0, 100));
  const wanted = [...all].sort((a, b) => Number(b.minted_at_ms) - Number(a.minted_at_ms)).slice(0, DETAIL_LIMIT);
  totalOutlives = all.length;
  outliveList = wanted;
  // Listing, owner and epoch come with the token list: show them before the vault reads land.
  const fresh = new Map(wanted.map((d) => [d.token_id, d]));
  rows = rows.filter((r) => fresh.has(r.outlive.token_id));
  for (const r of rows) r.outlive = fresh.get(r.outlive.token_id)!;
  const me = currentAccount();
  render();
  renderKpis();
  const upsert = (row: Row): void => {
    observe(row);
    const i = rows.findIndex((r) => r.outlive.token_id === row.outlive.token_id);
    if (i >= 0) rows[i] = row;
    else rows.push(row);
    rows.sort(byCalls);
    render();
    renderKpis();
  };
  const failed: OutliveView[] = [];
  for (const outlive of wanted) {
    try {
      upsert(await fetchRow(outlive, me));
    } catch {
      failed.push(outlive);
    }
    await sleep(400);
  }
  for (const outlive of failed) {
    try {
      upsert(await withBackoff(() => fetchRow(outlive, me)));
    } catch {
      // truly unreadable: an earlier read (if any) stays on the board
    }
  }
  const top = featured();
  if (top) wantCert(top.row.outlive.token_id);
}

let loading = false;
let again = false;
let lastLoadAt = 0;

/** One load at a time, and none while the tab is hidden: a background tab spends no RPC. */
async function refresh(force = false): Promise<void> {
  if (loading) {
    again = again || force;
    return;
  }
  if (!force && document.hidden) return;
  loading = true;
  try {
    await load();
    render();
    renderKpis();
    $("status").replaceChildren();
    $("status").className = "status";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (rows.length > 0) status(`Refresh failed (${msg}). Showing the last good read; retrying in ${REFRESH_MS / 1000} s.`, "quiet");
    else status(`Could not read the chain: ${msg}. Retrying in ${REFRESH_MS / 1000} s.`, "error");
  } finally {
    loading = false;
    lastLoadAt = Date.now();
  }
  if (again) {
    again = false;
    void refresh(true);
  }
}

// ---------------------------------------------------------------- derived figures

const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const fmtInt = (n: number) => Math.round(n).toLocaleString();
const fmtAmt = (digits: number) => (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: digits });
const fmtNum = (n: number) => fmtAmt(4)(n);

function paybackOf(r: Row): PaybackResult | null {
  if (!r.outlive.listing) return null;
  return payback({
    price: BigInt(r.outlive.listing.price),
    cash: BigInt(r.info.revenue),
    revenue30d: BigInt(r.stats.revenue_30d),
    gasSpent30dYocto: BigInt(r.stats.gas_spent_30d),
    vaultCreatedAtMs: Number(r.info.created_at_ms),
    nowMs: Date.now(),
    nearPrice: NEAR_PRICE_USD,
    tokenDecimals: token.decimals,
  });
}

/** The rule in words, worded after sdk/src/payback.ts. */
const paybackRule = (): string =>
  `${PAYBACK_LABEL} = (price − withdrawable proceeds, at least 0) ÷ net per day, where net per day = ` +
  `(revenue, 30 days − on-chain gas, 30 days at ${NEAR_PRICE_USD} USD/NEAR) ÷ days since the vault opened (1 to 30). ` +
  `Hosting, bandwidth and operator time are not included. The board uses all 30-day revenue; the buyer agent counts only revenue from independent customers.`;

function paybackText(p: PaybackResult | null): string {
  if (!p) return "–";
  return p.paybackDays === null ? "no payback at current revenue" : `${p.paybackDays.toFixed(1)} days`;
}

/** The same rule with this token's numbers, so anyone can redo the division. */
function paybackMath(r: Row, p: PaybackResult): string {
  const l = r.outlive.listing!;
  const price = toUnits(BigInt(l.price), token.decimals);
  const cash = toUnits(BigInt(r.info.revenue), token.decimals);
  const days = p.windowDays;
  const rev = p.revenuePerDay * days;
  const gas = p.gasPerDay * days;
  const head = `(price ${fmtNum(price)} − proceeds ${fmtNum(cash)}) ÷ ((revenue ${fmtNum(rev)} − on-chain gas ${fmtNum(gas)}) ÷ ${days.toFixed(1)} days)`;
  return p.paybackDays === null
    ? `${head}: net revenue is not above zero, so no payback at current revenue`
    : `${head} = ${p.paybackDays.toFixed(1)} days. Hosting, bandwidth and operator time are not included.`;
}

function ago(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.ceil(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.ceil(m / 60)} h`;
}

const ACTIVE_MS = 10 * 60_000;

/** Worker status from data already read: the page's own reads, else the vault's day buckets. */
function workerText(r: Row, now = Date.now()): string {
  const s = seen.get(r.outlive.token_id);
  if (s?.callAfter) {
    const since = now - s.callAfter;
    const text = `last paid call under ${ago(since)} ago`;
    return since < ACTIVE_MS ? `Worker active, ${text}` : text[0]!.toUpperCase() + text.slice(1);
  }
  const busy = r.stats.days.filter((d) => d.calls > 0).map((d) => d.day);
  if (busy.length === 0) return "No paid calls in 30 days";
  const d = r.stats.today - Math.max(...busy);
  if (d <= 0) return "Last paid call today (UTC)";
  if (d === 1) return "Last paid call yesterday (UTC)";
  return `Last paid call ${d} days ago`;
}

function workerActive(r: Row): boolean {
  const s = seen.get(r.outlive.token_id);
  return !!s?.callAfter && Date.now() - s.callAfter < ACTIVE_MS;
}

/** Relative times tick in place between reads, so "under 40 s" never goes stale. */
function workerLine(r: Row): HTMLElement {
  return h("p", { class: workerActive(r) ? "worker on" : "worker", "data-worker": r.outlive.token_id }, workerText(r));
}

function tickWorkers(): void {
  for (const el of document.querySelectorAll<HTMLElement>("[data-worker]")) {
    const r = rows.find((x) => x.outlive.token_id === el.dataset.worker);
    if (!r) continue;
    const text = workerText(r);
    if (el.textContent !== text) el.textContent = text;
    el.classList.toggle("on", workerActive(r));
  }
}

const isLoopback = (url: string) => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);

// ---------------------------------------------------------------- small pieces

function figure(label: string, value: Child, title?: string): HTMLElement {
  return h("div", { class: "fig", ...(title ? { title } : {}) }, h("dt", {}, label), h("dd", {}, value));
}

/** Numbers that roll up on first sight: the board feels alive without faking data.
 *  The final value is painted synchronously — rAF never runs in a hidden tab — and the
 *  roll-up only decorates a visible page. The unit span is never touched by the loop. */
function countUp(target: number, format: (n: number) => string): HTMLElement {
  const roll = h("span", { class: "roll" }, format(target));
  const dd = h("dd", {}, roll);
  if (reduceMotion() || document.visibilityState !== "visible") return dd;
  const t0 = performance.now();
  const dur = 650;
  const step = (t: number): void => {
    if (document.visibilityState !== "visible") {
      roll.replaceChildren(format(target));
      return;
    }
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    roll.replaceChildren(format(target * eased));
    if (p < 1) requestAnimationFrame(step);
    else roll.replaceChildren(format(target));
  };
  requestAnimationFrame(step);
  return dd;
}

/** Skeleton rows so the board's shape lands before the rate-limited reads do. */
function skeleton(n: number): HTMLElement {
  const box = h("div", { "aria-hidden": "true" });
  for (let i = 0; i < n; i++) {
    box.append(
      h("div", { class: "skel", style: `animation-delay:${i * 60}ms` }, h("div", { class: "b r" }), h("div", { class: "b t" }), h("div", { class: "b f" }), h("div", { class: "b f" })),
    );
  }
  return box;
}

function form(fields: { name: string; placeholder: string; value?: string }[], button: string, onSubmit: (values: Record<string, string>) => void): HTMLFormElement {
  const f = h("form", { class: "action" });
  for (const field of fields) {
    const input = h("input", { name: field.name, placeholder: field.placeholder, "aria-label": field.placeholder, autocomplete: "off" });
    if (field.value) input.value = field.value;
    f.append(input);
  }
  f.append(h("button", { type: "submit" }, button));
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f).entries()) as Record<string, string>;
    try {
      onSubmit(data);
    } catch (err) {
      status(err instanceof Error ? err.message : String(err), "error");
    }
  });
  return f;
}

function button(text: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = h("button", { type: "button", class: cls }, text);
  b.addEventListener("click", onClick);
  return b;
}

// ---------------------------------------------------------------- buying

/** Disconnected, the buy button opens the wallet; connected, it sends the purchase. */
function buy(r: Row): void {
  const l = r.outlive.listing;
  if (!l) return;
  if (!currentAccount()) {
    void connect().catch((e) => status(String(e), "error"));
    return;
  }
  const msg = JSON.stringify({ buy: { token_id: r.outlive.token_id, max_price: l.price, listing_id: l.listing_id } });
  void act("Buy", token.contract, [{ method: "ft_transfer_call", args: { receiver_id: OUTLIVE_CONTRACT, amount: l.price, msg }, gasTgas: 250, depositYocto: ONE_YOCTO }]);
}

/** The one primary action of the page, in the featured block and in every sale panel. */
function buyButton(r: Row, me: string | null): HTMLElement | null {
  const l = r.outlive.listing;
  if (!l) return null;
  if (me && me === l.seller) return null;
  const b = button(`Buy this token, ${amount(l.price)} ${token.symbol}`, () => buy(r), "primary buy");
  if (!l.active) {
    b.disabled = true;
    b.textContent = "Listing activating";
  }
  return b;
}

function salePanel(r: Row, me: string | null, p: PaybackResult | null): HTMLElement | null {
  const l = r.outlive.listing;
  if (!l || !p) return null;
  const box = h(
    "section",
    { class: "sale", "aria-label": "Sale" },
    h("p", { class: "sale-head" }, `For sale, ${amount(l.price)} ${token.symbol}`, h("span", { class: "sale-by" }, ` Listing #${l.listing_id} by ${l.seller}${l.active ? "" : ", activating"}.`)),
    h("p", { class: "note" }, `Withdrawable proceeds (${amount(r.info.revenue)} ${token.symbol}) come with the outlive. Customer credit (${amount(r.info.liabilities)} ${token.symbol}) is a liability: it stays owed to customers and the owner can never withdraw it.`),
    h("p", { class: "note math", title: paybackRule() }, `${PAYBACK_LABEL}: ${paybackMath(r, p)}`),
    h("p", { class: "note fine" }, "This is a transferable service instance: the vault, its keys and its customer ledger. Servers, domains and code are off chain and do not move with the token."),
  );
  const buyBtn = buyButton(r, me);
  if (buyBtn) box.append(buyBtn, h("p", { class: "note fine" }, `The purchase is pinned to listing #${l.listing_id}, so a cancelled and re-listed token is refused and refunded.`));
  else if (me && me === l.seller) {
    box.append(button("Cancel listing", () => void act("Cancel listing", OUTLIVE_CONTRACT, [{ method: "cancel_listing", args: { token_id: r.outlive.token_id }, gasTgas: 100, depositYocto: ONE_YOCTO }])));
  }
  return box;
}

/** Holder-only actions. Rendered inside the holder console, never for anyone else. */
function ownerActions(r: Row): HTMLElement {
  const v = r.outlive.vault_id;
  const locked = r.info.locked;
  const panel = h("div", { class: "panel-body" });
  if (locked) panel.append(h("p", { class: "note" }, "The vault is locked while the token is listed: no withdraw, rotation, config or price change."));
  if (!r.outlive.listing) {
    panel.append(form([{ name: "price", placeholder: `price in ${token.symbol}` }], "List for sale", (f) => {
      const price = fromUnits(f.price ?? "", token.decimals).toString();
      void act("List", OUTLIVE_CONTRACT, [{ method: "list", args: { token_id: r.outlive.token_id, price }, gasTgas: 100, depositYocto: ONE_YOCTO }]);
    }));
  }
  panel.append(
    form([{ name: "amount", placeholder: `amount (max ${amount(r.info.revenue)})`, value: amount(r.info.revenue, token.decimals) }], "Withdraw revenue", (f) => {
      void act("Withdraw", v, [{ method: "withdraw", args: { amount: fromUnits(f.amount ?? "0", token.decimals).toString() }, gasTgas: 80, depositYocto: ONE_YOCTO }]);
    }),
    form(
      [
        { name: "key", placeholder: "new worker public key (ed25519:…)" },
        { name: "endpoint", placeholder: "new endpoint URL", value: r.info.endpoint },
        { name: "allowance", placeholder: "gas allowance in NEAR", value: "2" },
      ],
      "Rotate worker",
      (f) => {
        const allowance = ((BigInt(Math.round(Number(f.allowance || "2") * 1000)) * NEAR) / 1000n).toString();
        // Key and endpoint in one transaction.
        void act("Rotate worker", v, [
          { method: "set_worker", args: { public_key: f.key, allowance }, gasTgas: 60, depositYocto: ONE_YOCTO },
          { method: "set_config", args: { endpoint: f.endpoint, image_hash: r.info.image_hash }, gasTgas: 20, depositYocto: ONE_YOCTO },
        ]);
      },
    ),
    form(
      [
        { name: "endpoint", placeholder: "endpoint URL", value: r.info.endpoint },
        { name: "image", placeholder: "image hash", value: r.info.image_hash },
      ],
      "Set config",
      (f) => void act("Set config", v, [{ method: "set_config", args: { endpoint: f.endpoint, image_hash: f.image }, gasTgas: 20, depositYocto: ONE_YOCTO }]),
    ),
  );
  return panel;
}

function customerPanel(r: Row, me: string): { summary: string; body: HTMLElement } {
  const v = r.outlive.vault_id;
  const c = r.me;
  const panel = h("div", { class: "panel-body" });
  if (c) {
    panel.append(
      h(
        "dl",
        { class: "figs" },
        figure("balance", h("span", { class: "num" }, `${amount(c.balance)} ${token.symbol}`)),
        figure("daily cap", h("span", { class: "num" }, amount(c.daily_cap))),
        figure("spent today", h("span", { class: "num" }, amount(c.spent_today))),
        figure("last seq", h("span", { class: "num" }, c.last_seq)),
        c.pending_daily_cap ? figure("cap from " + new Date(Number(c.daily_cap_effective_at_ms)).toLocaleTimeString(), h("span", { class: "num" }, amount(c.pending_daily_cap))) : null,
      ),
    );
  } else {
    panel.append(h("p", { class: "note" }, `Not a customer yet. The first deposit must be at least ${amount(r.info.min_deposit)} ${token.symbol}.`));
  }
  panel.append(
    form([{ name: "amount", placeholder: `deposit in ${token.symbol}` }], "Deposit", (f) => {
      void act("Deposit", token.contract, [{ method: "ft_transfer_call", args: { receiver_id: v, amount: fromUnits(f.amount ?? "0", token.decimals).toString(), msg: "" }, gasTgas: 60, depositYocto: ONE_YOCTO }]);
    }),
  );
  if (c) {
    panel.append(
      form([{ name: "cap", placeholder: `daily cap in ${token.symbol}` }], "Set daily cap", (f) => {
        void act("Set daily cap", v, [{ method: "set_daily_cap", args: { amount: fromUnits(f.cap ?? "0", token.decimals).toString() }, gasTgas: 20, depositYocto: 0n }]);
      }),
    );
    if (c.refund_requested_at_ms === null) {
      panel.append(button("Request refund", () => void act("Request refund", v, [{ method: "request_refund", args: {}, gasTgas: 20, depositYocto: 0n }])));
    } else {
      const at = Number(c.refund_available_at_ms);
      const ready = Date.now() >= at;
      panel.append(
        h("p", { class: "note" }, ready ? "Your refund is ready." : `Refund available at ${new Date(at).toLocaleTimeString()}. The worker no longer serves you.`),
        button("Claim refund", () => void act("Claim refund", v, [{ method: "claim_refund", args: {}, gasTgas: 60, depositYocto: 0n }]), ready ? "primary" : ""),
      );
    }
  }
  panel.prepend(h("p", { class: "note" }, `Signed in as ${me}.`));
  return { summary: "Customer credit", body: panel };
}

/**
 * The token detail's operator console. The owner comes from nft_token, not from the cached outlive
 * row, and the actions live only in the holder branch: a locked console contains no form or
 * button that can call a vault owner method.
 */
function consoleSection(r: Row, me: string | null, customer: { summary: string; body: HTMLElement } | null): HTMLElement {
  const key = r.outlive.token_id;
  const read = ownerReads.get(key) ?? null;
  const owner = read?.status === "ok" ? read.owner : null;
  const box = h("section", { class: "console", "data-console": key, "aria-label": "Console" });

  if (owner && isHolder(owner, me)) {
    box.append(
      h("h2", { class: "console-title" }, "Console"),
      h("p", { class: "console-owner" }, "Holder console. Current owner: ", link(`address/${owner}`, owner), ". Signed in as ", me ?? "", "."),
      ownerActions(r),
    );
    if (customer) box.append(h("h3", { class: "console-sub" }, "Customer credit & refunds"), customer.body);
    return box;
  }

  const current: Child =
    read?.status === "ok"
      ? owner
        ? link(`address/${owner}`, owner)
        : h("span", { class: "muted" }, "none")
      : read?.status === "error"
        ? h("span", { class: "muted" }, `not read (${read.error ?? "RPC error"})`)
        : h("span", { class: "muted" }, "reading from the chain…");
  box.append(
    h(
      "div",
      { class: "console-locked" },
      h("h2", { class: "console-title" }, "Holder console - locked"),
      h("p", { class: "console-owner" }, "Current owner: ", current),
      h(
        "p",
        { class: "note" },
        owner ? `Connect as ${owner} to withdraw revenue, rotate the worker or manage customer credit and refunds.` : "Connect a testnet wallet that holds this token to use the console.",
      ),
    ),
  );
  return box;
}

/** 30 daily bars from the vault's day buckets: quiet days are real zeros (a 2px tick), active
 *  days carry the signal, and the peak is labeled. Real on-chain history, no invention. */
function spark(stats: VaultStatsView): HTMLElement {
  const byDay = new Map(stats.days.map((d) => [d.day, d.calls]));
  const today = stats.today;
  const last = Array.from({ length: 30 }, (_, k) => ({ day: today - 29 + k, calls: byDay.get(today - 29 + k) ?? 0 }));
  const max = Math.max(0, ...last.map((d) => d.calls));
  const peakAt = max > 0 ? last.findIndex((d) => d.calls === max) : -1;
  const dayDate = (day: number) => new Date(day * 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
  const label = max > 0 ? `Calls per day, last 30 days; peak ${max} on ${dayDate(last[peakAt]!.day)}` : "Calls per day, last 30 days; none";
  const bars = h("div", { class: "bars", role: "img", "aria-label": label });
  last.forEach((d, i) => {
    const bar = h("span", {
      class: d.calls ? "bar on" : "bar",
      style: d.calls ? `height:${Math.max(6, Math.round((d.calls / max) * 100))}%` : "",
      title: `${dayDate(d.day)}, ${d.calls} calls`,
    });
    if (i === peakAt) {
      bar.classList.add("peak");
      bar.append(h("i", { class: i > 24 ? "peak-label end" : "peak-label" }, fmtInt(max)));
    }
    bars.append(bar);
  });
  const first = last[0]?.day ?? today;
  return h(
    "div",
    { class: "spark" },
    h("p", { class: "spark-title" }, "Calls per day, 30 days"),
    bars,
    h("p", { class: "cap" }, h("span", {}, dayDate(first)), h("span", {}, dayDate(today))),
  );
}

// ---------------------------------------------------------------- earnings history

const dayTime = (ms: number) => new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

function span(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `${hrs} h`;
  return `${Math.round(hrs / 24)} days`;
}

const txLink = (hash: string, text: string) => {
  const a = link(`txns/${hash}`, text);
  a.title = `Transaction ${hash}`;
  return a;
};

const OPENED: Record<Epoch["openedBy"], string> = { mint: "minted", sale: "bought", transfer: "received", unknown: "" };

/** One ledger row per ownership epoch. */
function epochRow(ep: Epoch, r: Row, me: string | null): HTMLTableRowElement {
  const current = ep.toMs === null;
  const cell = (cls: string, label: string, ...kids: Child[]) => h("td", { class: cls, "data-label": label }, ...kids);
  const held =
    ep.fromMs === null
      ? h("span", { class: "muted" }, "start not read")
      : current
        ? [`${dayTime(ep.fromMs)} to now`, h("span", { class: "sub" }, `held ${span(Date.now() - ep.fromMs)}`)]
        : [
            `${dayTime(ep.fromMs)} to ${sameDay(ep.fromMs, ep.toMs!) ? clock(ep.toMs!) : dayTime(ep.toMs!)}`,
            h("span", { class: "sub" }, `held ${span(ep.toMs! - ep.fromMs)}`),
          ];
  let sold: Child[];
  if (ep.ended?.by === "sale") sold = [`${amount(ep.ended.price)}`, h("span", { class: "sub" }, `to ${ep.ended.buyer}`)];
  else if (ep.ended?.by === "transfer") sold = [h("span", { class: "muted" }, "no sale"), h("span", { class: "sub" }, `transferred to ${ep.ended.to}`)];
  else if (r.outlive.listing) sold = [h("span", { class: "muted" }, `listed at ${amount(r.outlive.listing.price)}`)];
  else sold = [h("span", { class: "muted" }, "still held")];

  const proof: Child[] = [];
  if (ep.opened && ep.openedBy !== "unknown") proof.push(txLink(ep.opened.tx, OPENED[ep.openedBy]));
  ep.payouts.slice(0, 3).forEach((p, i) => proof.push(txLink(p.tx, ep.payouts.length > 1 ? `payout ${i + 1}` : "payout")));
  if (ep.payouts.length > 3) proof.push(h("span", { class: "muted" }, `+${ep.payouts.length - 3} payouts`));
  const ch = ep.chargeTxs;
  if (ch.length === 1) proof.push(txLink(ch[0]!.tx, "charge"));
  else if (ch.length > 1) proof.push(txLink(ch[0]!.tx, "first charge"), txLink(ch[ch.length - 1]!.tx, "last charge"));
  if (ep.ended?.by === "sale") proof.push(txLink(ep.ended.tx, "sale"));
  else if (ep.ended?.by === "transfer") proof.push(txLink(ep.ended.tx, "transfer"));

  const payoutNote = ep.payouts.length > 0 && ep.payouts.some((p) => p.receiver !== ep.holder) ? h("span", { class: "sub" }, `to ${[...new Set(ep.payouts.map((p) => p.receiver))].join(", ")}`) : null;
  const left = !current && BigInt(ep.cashOut) > 0n ? h("span", { class: "sub" }, `${amount(ep.cashOut)} left in the vault, went with the token`) : null;
  return h(
    "tr",
    { class: current ? "ep now" : "ep" },
    h("th", { scope: "row", class: "l-ep" }, h("span", { class: "ep-n", "aria-label": `epoch ${ep.epoch}${current ? ", current" : ""}` }, String(ep.epoch))),
    cell(
      "l-holder",
      "holder",
      ep.holder ? Object.assign(link(`address/${ep.holder}`, ep.holder), { title: ep.holder }) : h("span", { class: "muted" }, "not read"),
      me && me === ep.holder ? h("span", { class: "you" }, " you") : null,
      h("span", { class: "sub" }, ep.openedBy === "unknown" ? "how it was acquired was not read" : `${OPENED[ep.openedBy]} the token`),
    ),
    cell("l-held", "held", ...[held].flat()),
    cell("l-num", "paid calls", fmtInt(ep.calls)),
    cell("l-num", "revenue", amount(ep.revenue)),
    cell("l-num", "paid out", amount(ep.withdrawn), payoutNote, left),
    cell("l-num l-sold", "sold for", ...sold),
    cell("l-proof", "proof", h("span", { class: "proofs" }, ...proof)),
  );
}

/** The ledger plus the check against the contract's own counters. */
function fillHistory(box: HTMLElement, r: Row): void {
  const vault = r.outlive.vault_id;
  const s: HistoryState | null = historyState(vault);
  const me = currentAccount();
  const head = h(
    "div",
    { class: "hist-head" },
    h("h3", { class: "hist-title", id: `hist-${r.outlive.token_id}` }, "Earnings history"),
    h("p", { class: "hist-lede" }, `Each holder, what the service earned while they held it, what they paid out, and what they sold it for. Newest first, amounts in ${token.symbol}.`),
  );
  // A click inside the minimum gap repaints from the cache without a request.
  const again = button(s?.status === "loading" ? "Reading" : "Read again", () => (canReadAgain(historyState(vault)) ? wantHistory(vault, true) : fillHistory(box, r)), "small");
  again.disabled = s?.status === "loading";
  head.append(again);
  const parts: Child[] = [head];

  if (!s || (s.status === "loading" && !s.history)) {
    parts.push(h("p", { class: "hist-wait" }, h("span", { class: "dot", "aria-hidden": "true" }), "Reading the vault's event log"));
  } else if (s.status === "error" && !s.history) {
    parts.push(
      h(
        "div",
        { class: "hist-off" },
        h("p", {}, "History unavailable right now, the live figures above come straight from the contract."),
        h("p", { class: "note fine" }, `The transaction index (${new URL(TX_INDEX).host}) did not answer: ${s.error ?? "no reason given"}. `, link(`address/${vault}`, "See the vault on NearBlocks"), "."),
      ),
    );
  } else if (s.history && s.history.epochs.length === 0) {
    parts.push(h("p", { class: "hist-off" }, s.listed === 0 ? "The index lists no transactions for this vault yet. A new vault usually shows up within a minute." : "No mint, sale, charge or payout events were found in this vault's transactions yet."));
  } else if (s.history) {
    const hist = s.history;
    const t = hist.totals;
    const first = hist.epochs[hist.epochs.length - 1];
    const table = h(
      "table",
      { class: "ledger", "aria-labelledby": `hist-${r.outlive.token_id}` },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", { scope: "col", class: "l-ep" }, "epoch"),
          h("th", { scope: "col" }, "holder"),
          h("th", { scope: "col" }, "held"),
          h("th", { scope: "col", class: "l-num" }, "paid calls"),
          h("th", { scope: "col", class: "l-num" }, "revenue"),
          h("th", { scope: "col", class: "l-num" }, "paid out"),
          h("th", { scope: "col", class: "l-num" }, "sold for"),
          h("th", { scope: "col" }, "proof"),
        ),
      ),
      h("tbody", {}, ...hist.epochs.map((ep) => epochRow(ep, r, me))),
      h(
        "tfoot",
        {},
        h(
          "tr",
          {},
          h("th", { scope: "row", class: "l-ep" }, "all"),
          h("td", { class: "l-holder", "data-label": "holders" }, `${t.holders} ${t.holders === 1 ? "holder" : "holders"}`),
          h("td", { class: "l-held", "data-label": "held" }, hist.fromMint && first?.fromMs ? `since ${dayTime(first.fromMs)}` : "since the oldest event read"),
          h("td", { class: "l-num", "data-label": "paid calls" }, fmtInt(t.calls)),
          h("td", { class: "l-num", "data-label": "revenue" }, amount(t.revenue)),
          h("td", { class: "l-num", "data-label": "paid out" }, amount(t.withdrawn)),
          h("td", { class: "l-num", "data-label": "sold for" }, ...(t.sales === 0 ? [h("span", { class: "muted" }, "no sales")] : [amount(t.salesVolume), h("span", { class: "sub" }, `${t.sales} ${t.sales === 1 ? "sale" : "sales"}`)])),
          h("td", { class: "l-proof" }),
        ),
      ),
    );
    parts.push(h("div", { class: "ledger-wrap" }, table));

    // The audit line: the event log against the vault's own all-time counters.
    const rec = reconcile(hist, { callsTotal: r.stats.calls_total, revenueTotal: r.stats.revenue_total, cash: r.info.revenue, inFlight: r.info.in_flight });
    const paidOut = BigInt(r.stats.revenue_total) - BigInt(r.info.revenue) - BigInt(r.info.in_flight);
    const counters = `${fmtInt(r.stats.calls_total)} paid calls, ${amount(r.stats.revenue_total)} ${token.symbol} earned, ${amount(paidOut)} paid out, ${amount(r.info.revenue)} in the vault`;
    if (rec.matches && hist.fromMint) {
      parts.push(h("p", { class: "hist-check ok" }, h("strong", {}, "Adds up."), ` The vault's own counters say ${counters}.`));
    } else {
      const gaps: string[] = [];
      if (rec.calls !== 0 || rec.revenue !== 0n) gaps.push(`${fmtInt(Math.abs(rec.calls))} paid calls and ${amount(rec.revenue < 0n ? -rec.revenue : rec.revenue)} ${token.symbol} of revenue`);
      if (rec.withdrawn !== 0n) gaps.push(`${amount(rec.withdrawn < 0n ? -rec.withdrawn : rec.withdrawn)} ${token.symbol} of payouts`);
      const why =
        !hist.fromMint
          ? "The mint was not read, so the oldest figures are missing."
          : rec.calls > 0 || rec.revenue > 0n || rec.withdrawn > 0n
            ? "The newest transactions are not in the index yet; read again in a minute."
            : "The contract figures above are older than the log; they update on the next refresh.";
      parts.push(h("p", { class: "hist-check" }, h("strong", {}, "Not complete yet."), ` The vault's own counters say ${counters}. ${gaps.length ? `The log read so far differs by ${gaps.join(" and ")}. ` : ""}${why}`));
    }

    const custs = customersBlock(r, s);
    if (custs) parts.push(custs);

    const notes: string[] = [];
    if (s.unread > 0) notes.push(`${s.unread} newer transactions are still unread; Read again continues.`);
    if (s.status === "error") notes.push(`The last read failed (${s.error ?? "no answer"}); this is the read from ${clock(s.readAt)}.`);
    parts.push(
      h(
        "p",
        { class: "note fine hist-src" },
        `From the vault's NEP-297 events (vault_charge, vault_deposit, vault_withdraw, vault_owner) and the token's outlive_sold, read through ${new URL(TX_INDEX).host}: ${s.listed} transactions, read at ${clock(s.readAt)}. Revenue is exact per epoch: a charge belongs to whoever held the token when it executed. Proof links open on NearBlocks. `,
        notes.join(" "),
      ),
    );
  }
  box.replaceChildren(...parts.filter((x): x is Node | string => !!x));
  box.setAttribute("aria-busy", String(s?.status === "loading"));
}

type CustomerKind = "owner" | "owner-funded" | "demo" | "other";
const KIND_TEXT: Record<CustomerKind, string> = {
  owner: "owner, now or before",
  "owner-funded": "credit paid in by an owner",
  demo: "our demo traffic agent",
  other: "not ours",
};

/** Every paying or depositing customer in the events read, with what it paid and who it is. */
function customersBlock(r: Row, s: HistoryState): HTMLElement | null {
  const owners = new Set([r.info.owner_id, ...ownersFromEvents(s.events)]);
  const list = new Map<string, { calls: number; paid: bigint; senders: Set<string> }>();
  const get = (c: string) => list.get(c) ?? (list.set(c, { calls: 0, paid: 0n, senders: new Set() }), list.get(c)!);
  for (const e of s.events) {
    if (e.kind === "deposit" && e.customer) get(e.customer).senders.add(e.sender);
    if (e.kind === "charge") for (const it of e.items ?? []) {
      if (!it.customer) continue;
      const c = get(it.customer);
      c.calls += it.units;
      c.paid += BigInt(it.cost);
    }
  }
  if (list.size === 0) return null;
  const kindOf = (c: string, senders: Set<string>): CustomerKind => {
    if (owners.has(c)) return "owner";
    if ([...senders].some((x) => x !== c && owners.has(x))) return "owner-funded";
    if (isProjectDemoAccount(c, [...senders])) return "demo";
    return "other";
  };
  const rowsOut = [...list.entries()].map(([c, x]) => ({ c, ...x, kind: kindOf(c, x.senders) })).sort((a, b) => (b.paid > a.paid ? 1 : b.paid < a.paid ? -1 : a.c < b.c ? -1 : 1));
  const n = (k: CustomerKind) => rowsOut.filter((x) => x.kind === k).length;
  const summary =
    `${rowsOut.length} distinct ${rowsOut.length === 1 ? "customer" : "customers"} in the events read: ` +
    `${n("demo")} our own demo traffic ${n("demo") === 1 ? "agent" : "agents"}, ${n("other")} not ours` +
    (n("owner") + n("owner-funded") > 0 ? `, ${n("owner")} owner ${n("owner") === 1 ? "account" : "accounts"} and ${n("owner-funded")} paid in by an owner` : "") +
    ".";
  const cell = (cls: string, ...kids: Child[]) => h("td", { class: cls }, ...kids);
  return h(
    "div",
    { class: "custs" },
    h("h3", { class: "hist-title" }, "Customers"),
    h("p", { class: "hist-lede" }, summary),
    h(
      "div",
      { class: "ledger-wrap" },
      h(
        "table",
        { class: "custs-table" },
        h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "customer"), h("th", { scope: "col", class: "l-num" }, "paid calls"), h("th", { scope: "col", class: "l-num" }, `paid, ${token.symbol}`), h("th", { scope: "col" }, "who"))),
        h(
          "tbody",
          {},
          ...rowsOut.map((x) =>
            h(
              "tr",
              {},
              cell("cu-acc", Object.assign(link(`address/${x.c}`, x.c), { title: x.c })),
              cell("l-num", fmtInt(x.calls)),
              cell("l-num", amount(x.paid)),
              cell("cu-kind", h("span", { class: x.kind === "other" ? "tag" : `tag ${x.kind === "demo" ? "ours" : "warn"}` }, KIND_TEXT[x.kind])),
            ),
          ),
        ),
      ),
    ),
    h(
      "p",
      { class: "note fine" },
      "Our demo traffic agents are outlive-alice, outlive-bob and accounts funded by outlive-seller*, outlive-hostile and outlive-wash. Traffic in the recorded demos comes from these agents. " +
        "Customers whose credit an owner paid in are marked here; the buyer agent also reads each customer's own funding history and counts only independent revenue.",
    ),
  );
}

function historySection(r: Row): HTMLElement {
  const box = h("section", { class: "history", "data-history": r.outlive.vault_id, "aria-label": "Earnings history" });
  fillHistory(box, r);
  return box;
}

/** A finished read repaints only the history sections of that vault: rows are not rebuilt. */
onHistory((vault) => {
  for (const box of document.querySelectorAll<HTMLElement>(`[data-history="${CSS.escape(vault)}"]`)) {
    const r = rows.find((x) => x.outlive.vault_id === vault);
    if (r) fillHistory(box, r);
  }
});

/** Opens a token's row on the board (switching tab if needed) and brings its history into view. */
function openHistory(key: string): void {
  const r = rows.find((x) => x.outlive.token_id === key);
  if (!r) return;
  if (activeTab() === "sale" && !r.outlive.listing) setTab("all");
  const art = document.querySelector<HTMLElement>(`#tokens [data-token="${CSS.escape(key)}"]`);
  const btn = art?.querySelector<HTMLButtonElement>(":scope > button.row");
  if (!art || !btn) return;
  if (!openKeys.has(key)) btn.click();
  else wantHistory(r.outlive.vault_id);
  art.querySelector<HTMLElement>(".history")?.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" });
}

function certImage(r: Row, cls: string): HTMLElement {
  const media = r.token?.metadata?.media;
  return media
    ? h("img", { class: cls, src: media, alt: `Certificate of ${outliveId(r.outlive)}, ${r.outlive.title}`, width: "640", height: "400" })
    : h("div", { class: `${cls} cert-ph`, role: "img", "aria-label": "Certificate loading" }, h("span", {}, "Certificate loading"));
}

// ---------------------------------------------------------------- the board

type Tab = "sale" | "all";
const TAB_KEY = "outlive.board.tab";

function readTab(): Tab | null {
  if (location.hash === "#for-sale") return "sale";
  if (location.hash === "#all") return "all";
  try {
    const v = localStorage.getItem(TAB_KEY);
    return v === "sale" || v === "all" ? v : null;
  } catch {
    return null;
  }
}

let chosenTab: Tab | null = readTab();

function counts(): { sale: number; all: number } {
  const list = outliveList.length > 0 ? outliveList : rows.map((r) => r.outlive);
  return { sale: list.filter((d) => d.listing).length, all: list.length };
}

/** "For sale" is the default whenever something is for sale. */
function activeTab(): Tab {
  if (counts().sale === 0) return "all";
  return chosenTab ?? "sale";
}

function setTab(tab: Tab, focus = false): void {
  chosenTab = tab;
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // private mode: the hash still carries it
  }
  history.replaceState(null, "", tab === "sale" ? "#for-sale" : "#all");
  render(false);
  if (focus) document.querySelector<HTMLElement>(`#tabs [data-tab="${tab}"]`)?.focus();
}

function renderTabs(): void {
  const box = $("tabs");
  const c = counts();
  const tab = activeTab();
  const make = (key: Tab, label: string, n: number): HTMLButtonElement => {
    const selected = key === tab;
    const b = h("button", {
      type: "button",
      role: "tab",
      class: "tab",
      "data-tab": key,
      id: `tab-${key}`,
      "aria-selected": String(selected),
      "aria-controls": "tokens",
      tabindex: selected ? "0" : "-1",
    }, label, h("span", { class: "n" }, `(${n})`));
    if (key === "sale" && n === 0) b.disabled = true;
    b.addEventListener("click", () => setTab(key));
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const other: Tab = key === "sale" ? "all" : "sale";
        if (other === "sale" && c.sale === 0) return;
        setTab(other, true);
      }
    });
    return b;
  };
  const sig = `${tab}|${c.sale}|${c.all}`;
  if (box.dataset.sig === sig) return;
  const hadFocus = box.contains(document.activeElement);
  box.dataset.sig = sig;
  box.replaceChildren(make("sale", "For sale ", c.sale), make("all", "All ", c.all));
  $("tokens").setAttribute("aria-labelledby", `tab-${tab}`);
  if (hadFocus) box.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
}

/** Which rows are open survives every refresh and re-render. */
const openKeys = new Set<string>();

function rowSig(r: Row, me: string | null): string {
  const s = seen.get(r.outlive.token_id);
  const o = ownerReads.get(r.outlive.token_id);
  return JSON.stringify([r.outlive, r.info, r.stats, r.me, me, token.symbol, !!r.token?.metadata?.media, s?.callAfter ?? null, o?.status ?? null, o?.owner ?? null]);
}

function entry(r: Row, rank: number, me: string | null): HTMLElement {
  const { outlive, info, stats } = r;
  const key = outlive.token_id;
  const id = outliveId(outlive);
  const p = paybackOf(r);
  const l = outlive.listing;
  const unit = () => h("span", { class: "unit" }, token.symbol);
  const cell = (cls: string, label: string, ...value: Child[]) => h("span", { class: `c ${cls}` }, h("span", { class: "lbl" }, label), h("span", { class: "val" }, ...value));
  const chip = l
    ? h("span", { class: "chip" }, "For sale", info.locked ? h("span", { class: "chip-lock" }, "locked") : null)
    : info.locked
      ? h("span", { class: "chip ink" }, "Locked")
      : null;
  const rowBtn = h(
    "button",
    {
      type: "button",
      class: "row",
      id: `row-${key}`,
      "aria-expanded": String(openKeys.has(key)),
      "aria-controls": `detail-${key}`,
      "aria-label": `${id}, ${outlive.title}. ${stats.calls_30d} paid calls in 30 days. ${l ? `For sale at ${amount(l.price)} ${token.symbol}, ${PAYBACK_LABEL} ${paybackText(p)}` : "Not listed"}. Show details.`,
    },
    h("span", { class: "c c-rank" }, String(rank + 1).padStart(2, "0")),
    h("span", { class: "c c-id" }, h("span", { class: "id" }, id), h("span", { class: "sub" }, outlive.title)),
    cell("c-calls", "calls, 30d", fmtInt(stats.calls_30d)),
    cell("c-rev", "revenue, 30d", amount(stats.revenue_30d, 2), " ", unit()),
    l ? cell("c-price", "price", amount(l.price), " ", unit()) : cell("c-price muted", "price", "not listed"),
    h(
      "span",
      { class: `c c-pay${p?.paybackDays == null ? " muted" : ""}`, title: l ? paybackRule() : "Not listed" },
      h("span", { class: "lbl" }, "payback, chain costs"),
      h("span", { class: "val" }, paybackText(p)),
    ),
    h("span", { class: "c c-status" }, chip),
    h("span", { class: "c c-act", "aria-hidden": "true" }),
  );

  const endpoint = info.endpoint || "none";
  const facts = h(
    "dl",
    { class: "figs" },
    figure("owner", link(`address/${info.owner_id}`, short(info.owner_id))),
    figure("price per call", h("span", { class: "num" }, `${amount(info.price_per_call, 6)} ${token.symbol}`, info.pending_price ? `, ${amount(info.pending_price, 6)} from ${new Date(Number(info.price_effective_at_ms)).toLocaleString()}` : "")),
    figure("withdrawable proceeds", h("span", { class: "num" }, `${amount(info.revenue)} ${token.symbol}`), "Earned revenue the owner may withdraw; goes to the buyer with the token"),
    figure("customer credit, owed", h("span", { class: "num" }, `${amount(info.liabilities)} ${token.symbol}`), "A liability: prepaid by customers, refundable to them, never withdrawable by the owner"),
    figure("gas spent, 30 days", h("span", { class: "num" }, `${near(stats.gas_spent_30d, 5)} NEAR`), "Estimated from the vault's NEAR balance at each charge"),
    figure("customers with credit", h("span", { class: "num" }, String(info.customers)), "Ledger entries in the vault now; who they are is listed under Customers below"),
    figure("calls, all time", h("span", { class: "num" }, fmtInt(stats.calls_total))),
    figure("revenue, all time", h("span", { class: "num" }, `${amount(stats.revenue_total)} ${token.symbol}`)),
    figure("owner epoch", h("span", { class: "num" }, String(info.owner_epoch)), "1 at mint, +1 each time the token changes hands (sale or transfer)"),
    figure("worker key", h("span", { class: "num", title: info.worker_key ?? "" }, short(info.worker_key))),
    figure("minted", h("span", { class: "num" }, new Date(Number(outlive.minted_at_ms)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }))),
    figure("vault", link(`address/${outlive.vault_id}`, short(outlive.vault_id, 8))),
  );
  const ownerRead = ownerReads.get(key);
  const holder = !!ownerRead && ownerRead.status === "ok" && isHolder(ownerRead.owner, me);
  const customer = me ? customerPanel(r, me) : null;
  // A holder manages their own customer credit in the console; everyone else keeps the
  // customer panel outside it, so deposits and refunds stay available to non-holders.
  const panels = [customer && !holder ? customer : null].filter((x): x is { summary: string; body: HTMLElement } => x !== null);
  const detail = h(
    "div",
    { class: "detail", id: `detail-${key}`, role: "region", "aria-labelledby": `row-${key}` },
    h(
      "div",
      { class: "detail-grid" },
      h(
        "div",
        { class: "detail-main" },
        workerLine(r),
        facts,
        spark(stats),
        h("p", { class: "endpoint" }, isLoopback(endpoint) ? "endpoint (local demo worker) " : "endpoint ", h("span", { class: "num" }, endpoint)),
      ),
      h("figure", { class: "detail-cert" }, certImage(r, "cert")),
    ),
    consoleSection(r, me, holder ? customer : null),
    historySection(r),
    salePanel(r, me, p),
    ...panels.map((x) => h("details", { class: "panel" }, h("summary", {}, x.summary), x.body)),
  );
  if (!openKeys.has(key)) detail.hidden = true;
  if (openKeys.has(key)) wantOwner(key);

  const art = h("article", { class: l ? "entry listed" : "entry", "data-token": key }, rowBtn, detail);
  rowBtn.addEventListener("click", () => {
    const open = !openKeys.has(key);
    if (open) openKeys.add(key);
    else openKeys.delete(key);
    rowBtn.setAttribute("aria-expanded", String(open));
    detail.hidden = !open;
    art.classList.toggle("open", open);
    if (open) {
      wantOwner(key, true);
      wantCert(key);
      wantHistory(outlive.vault_id);
      if (!reduceMotion()) {
        detail.classList.add("opening");
        detail.addEventListener("animationend", () => detail.classList.remove("opening"), { once: true });
      }
      detail.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
    }
  });
  art.classList.toggle("open", openKeys.has(key));
  return art;
}

/** Keyed render. A row whose data did not change keeps its element (no flicker, typed inputs
 *  survive); open rows and panels stay open; a row whose 30-day calls rose flashes once; a
 *  rank change slides rows into place (FLIP). Untouched rows never re-animate. */
function render(animate = true): void {
  renderHero();
  renderTabs();
  const list = $("tokens");
  const me = currentAccount();
  const tab = activeTab();
  const visible = tab === "sale" ? rows.filter((r) => r.outlive.listing) : rows;
  // Open consoles re-read nft_token when their cached owner is stale (they are the only place
  // holder actions exist); a transfer therefore cannot leave the old owner's buttons on screen.
  for (const r of visible) if (openKeys.has(r.outlive.token_id)) wantOwner(r.outlive.token_id);
  const expected = tab === "sale" ? counts().sale : counts().all;
  renderNote();
  if (visible.length === 0) {
    if (expected > 0 || rows.length === 0) {
      if (!list.querySelector(".skel")) list.replaceChildren(skeleton(Math.min(5, Math.max(1, expected || 5))));
    } else {
      list.replaceChildren(h("p", { class: "empty" }, "No tokens yet. Mint one with the seller agent, then reload."));
    }
    flashKeys.clear();
    return;
  }
  const before = new Map<string, { el: HTMLElement; index: number; top: number }>();
  [...list.querySelectorAll<HTMLElement>(":scope > .entry")].forEach((el, index) => {
    before.set(el.dataset.token ?? "", { el, index, top: el.getBoundingClientRect().top });
  });
  const firstPaint = before.size === 0;
  const fresh = visible.map((r, i) => {
    const key = r.outlive.token_id;
    const sig = rowSig(r, me);
    const old = before.get(key);
    const typing = old && old.el.contains(document.activeElement) && document.activeElement?.tagName === "INPUT";
    let el: HTMLElement;
    if (old && (old.el.dataset.sig === sig || typing)) {
      el = old.el;
      const rank = el.querySelector(".c-rank");
      if (rank) rank.textContent = String(i + 1).padStart(2, "0");
    } else {
      el = entry(r, i, me);
      el.dataset.sig = sig;
      if (old) {
        // Same row, new numbers: carry over which owner/customer panels were open.
        const was = [...old.el.querySelectorAll("details")].map((d) => d.open);
        [...el.querySelectorAll("details")].forEach((d, k) => (d.open = was[k] ?? false));
      } else if (animate) {
        el.classList.add("new");
        el.style.setProperty("--d", `${Math.min(i, 8) * 45}ms`);
      }
    }
    return el;
  });
  // Swap only when something changed, so a quiet refresh touches nothing.
  const same = fresh.length === list.children.length && fresh.every((el, i) => list.children[i] === el);
  if (!same) list.replaceChildren(...fresh);
  if (!animate || firstPaint || reduceMotion()) {
    flashKeys.clear();
    return;
  }
  // Slide only a true reorder of the same rows; rows arriving or leaving just take their place.
  const sameRows = fresh.length === before.size && fresh.every((el) => before.has(el.dataset.token ?? ""));
  fresh.forEach((el, i) => {
    const key = el.dataset.token ?? "";
    const old = before.get(key);
    if (sameRows && old && old.index !== i) {
      const dy = old.top - el.getBoundingClientRect().top;
      if (Math.abs(dy) > 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 300, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
    }
    if (flashKeys.has(key)) {
      el.classList.remove("flash");
      void el.offsetWidth;
      el.classList.add("flash");
      el.addEventListener("animationend", () => el.classList.remove("flash"), { once: true });
    }
  });
  flashKeys.clear();
}

function renderNote(): void {
  const note = $("board-note");
  const text = totalOutlives > outliveList.length ? `Showing the ${outliveList.length} newest of ${totalOutlives} tokens.` : "";
  if (note.textContent !== text) note.textContent = text;
}

// ---------------------------------------------------------------- hero

function featured(): { row: Row; forSale: boolean } | null {
  const sale = rows.find((r) => r.outlive.listing);
  if (sale) return { row: sale, forSale: true };
  return rows[0] ? { row: rows[0], forSale: false } : null;
}

/** The featured listing: the top outlive for sale by paid calls (else the most active outlive),
 *  its certificate, the three numbers a buyer weighs, and the page's one primary action. */
function renderHero(): void {
  const box = document.getElementById("featured");
  if (!box) return;
  const f = featured();
  if (!f) return; // keep the placeholder until the first row lands
  const { row: r, forSale } = f;
  const me = currentAccount();
  const sig = `${rowSig(r, me)}|${forSale}`;
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  const l = r.outlive.listing;
  const p = paybackOf(r);
  const id = outliveId(r.outlive);
  const figs = h("dl", { class: "feat-figs" });
  if (l && p) {
    figs.append(
      h("div", { class: p.paybackDays === null ? "fig big none" : "fig big", title: paybackRule() }, h("dt", {}, "payback on chain-visible costs"), h("dd", {}, paybackText(p))),
      figure("price", h("span", { class: "num" }, `${amount(l.price)} ${token.symbol}`)),
      figure("proceeds, come with it", h("span", { class: "num" }, `${amount(r.info.revenue)} ${token.symbol}`)),
    );
  } else {
    figs.append(
      h("div", { class: "fig big" }, h("dt", {}, "paid calls, 30 days"), h("dd", {}, fmtInt(r.stats.calls_30d))),
      figure("price", h("span", { class: "num muted" }, "not for sale")),
      figure("withdrawable proceeds", h("span", { class: "num" }, `${amount(r.info.revenue)} ${token.symbol}`)),
    );
  }
  const action = forSale ? buyButton(r, me) : null;
  const hist = h("a", { class: "feat-hist", href: `#detail-${r.outlive.token_id}` }, "See what it earned under each holder");
  hist.addEventListener("click", (e) => {
    e.preventDefault();
    openHistory(r.outlive.token_id);
  });
  const parts: (HTMLElement | null)[] = [
    h("h2", { class: "feat-h" }, forSale ? "Featured listing" : "Most active token"),
    certImage(r, "feat-cert"),
    h("p", { class: "feat-id" }, h("strong", {}, id), ` ${r.outlive.title}`),
    figs,
    action,
    hist,
    forSale && me && l && me === l.seller ? h("p", { class: "note" }, "This is your listing. Cancel it from the board.") : null,
    forSale ? h("p", { class: "note fine" }, `Ranked first of ${counts().sale} for sale by paid calls in 30 days.`) : h("p", { class: "note fine" }, "Nothing is for sale right now. This is the token with the most paid calls in 30 days."),
  ];
  box.replaceChildren(...parts.filter((x): x is HTMLElement => x !== null));
}

/** Live totals across the tokens on the board. Figures roll up once, then tick when the chain moves them. */
let kpiSeen = false;
const kpiLast: Record<string, number> = {};
function renderKpis(): void {
  const kpis = $("kpis");
  const calls30 = rows.reduce((n, r) => n + r.stats.calls_30d, 0);
  const rev30 = rows.reduce((n, r) => n + BigInt(r.stats.revenue_30d), 0n);
  const cash = rows.reduce((n, r) => n + BigInt(r.info.revenue), 0n);
  const items: [string, number, (n: number) => string, boolean][] = [
    ["tokens live", rows.length, fmtInt, false],
    ["paid calls, 30d", calls30, fmtInt, false],
    ["revenue, 30d", toUnits(rev30, token.decimals), fmtAmt(2), true],
    ["proceeds in vaults", toUnits(cash, token.decimals), fmtAmt(2), true],
  ];
  const sig = items.map((i) => i[1]).join("|") + token.symbol;
  if (kpis.dataset.sig === sig) return;
  kpis.dataset.sig = sig;
  kpis.replaceChildren(
    ...items.map(([label, value, fmt, unit]) => {
      const changed = kpiSeen && kpiLast[label] !== undefined && kpiLast[label] !== value;
      kpiLast[label] = value;
      const dd = countUp(value, fmt);
      if (changed) {
        dd.classList.add("tick");
        dd.addEventListener("animationend", () => dd.classList.remove("tick"), { once: true });
      }
      if (unit) dd.append(h("span", { class: "unit" }, token.symbol));
      return h("div", { class: "fig" }, h("dt", {}, label), dd);
    }),
  );
  kpiSeen = true;
}

function renderWallet(account: string | null): void {
  const box = $("wallet");
  box.replaceChildren(
    account ? h("span", { class: "who", title: account }, short(account, 8)) : "",
    account ? button("Disconnect", () => void disconnect()) : button("Connect wallet", () => void connect().catch((e) => status(String(e), "error")), "primary"),
  );
}

async function main(): Promise<void> {
  $("outlive-link").replaceChildren(link(`address/${OUTLIVE_CONTRACT}`, OUTLIVE_CONTRACT));
  $("tokens").replaceChildren(skeleton(5)); // the board's shape lands before the first read returns
  renderWallet(null);
  onAccount((a) => {
    renderWallet(a);
    // Relock (or unlock) open consoles at once and re-read the owner for the new account;
    // the refresh below updates the numbers.
    for (const key of openKeys) wantOwner(key, true);
    render();
    void refresh(true);
  });
  addEventListener("hashchange", () => {
    const t = readTab();
    if (t) {
      setTab(t);
      $("registry").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" });
    }
  });
  if (location.hash === "#for-sale" || location.hash === "#all") $("registry").scrollIntoView();
  // The secondary hero action: the board, on the For sale tab (works even when the hash is already set).
  document.querySelector(".cue")?.addEventListener("click", (e) => {
    e.preventDefault();
    setTab("sale");
    $("registry").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth" });
  });
  await refresh(true);
  void initWallet().catch(() => undefined);
  // The next read starts REFRESH_MS after the last one ended, so slow reads never stack up.
  const loop = async (): Promise<void> => {
    await sleep(REFRESH_MS);
    await refresh();
    void loop();
  };
  void loop();
  setInterval(tickWorkers, 5000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastLoadAt > REFRESH_MS) void refresh();
  });
  // The header anchors once the visitor scrolls into the board.
  const top = document.querySelector("header.top");
  addEventListener("scroll", () => top?.classList.toggle("scrolled", scrollY > 8), { passive: true });
}

void main();
