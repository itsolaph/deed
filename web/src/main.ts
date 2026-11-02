// Deed web app: every deed on the deed contract with live numbers from the contract views,
// its dynamic NFT certificate, and the actions for buyers, owners and customers.

import "./style.css";
import { Rpc, TESTNET_RPC_URLS } from "../../sdk/src/chain.js";
import { formatUnits, fromUnits, payback } from "../../sdk/src/payback.js";
import { DeedViews, VaultViews, type CustomerView, type DeedView, type NftToken, type VaultInfo, type VaultStatsView } from "../../sdk/src/views.js";
import { DEED_CONTRACT, EXPLORER, NEAR_PRICE_USD, REFRESH_MS } from "./config";
import { connect, currentAccount, disconnect, initWallet, onAccount, send, type Call } from "./wallet";

const rpc = new Rpc(TESTNET_RPC_URLS);
// Two orders of the same public endpoints: with free-tier limits of ~0.5 req/s each,
// alternating starts spreads the page's reads across both providers.
const rpcAlt = new Rpc([...TESTNET_RPC_URLS].reverse());
let rpcPicks = 0;
const pickRpc = (): Rpc => (rpcPicks++ % 2 === 0 ? rpc : rpcAlt);
const deedViews = new DeedViews(rpc, DEED_CONTRACT);
const ONE_YOCTO = 1n;
const NEAR = 10n ** 24n;

interface Row {
  deed: DeedView;
  info: VaultInfo;
  stats: VaultStatsView;
  token: NftToken | null;
  me: CustomerView | null;
}

let token = { contract: "", symbol: "tUSDC", decimals: 6 };
let rows: Row[] = [];

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
    setTimeout(() => void refresh(), 2500);
  } catch (e) {
    status(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

// ---------------------------------------------------------------- data

/** How many deeds get full detail (vault views) per load. Every extra deed costs RPC calls
 *  against rate-limited public endpoints; the rest stay listed but unexpanded. */
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

async function fetchRow(deed: DeedView, me: string | null, withCert: boolean): Promise<Row> {
  const vault = new VaultViews(pickRpc(), deed.vault_id);
  // Sequential on purpose: two providers at ~0.5 req/s each cannot absorb bursts.
  const info = await vault.info();
  await sleep(500);
  const stats = await vault.stats();
  const mine = me ? (await sleep(500), await vault.customer(me)) : null;
  const nft = withCert ? (await sleep(500), await deedViews.token(deed.token_id)) : null;
  return { deed, info, stats, token: nft, me: mine };
}

let certBusy = false;

/** Certificates are pure metadata: fill them in one at a time after the numbers are up. */
async function loadCerts(): Promise<void> {
  if (certBusy) return;
  certBusy = true;
  try {
    for (const r of rows) {
      if (!r.token) {
        try {
          r.token = await deedViews.token(r.deed.token_id);
          render();
        } catch {
          // keep the placeholder
        }
        await new Promise((res) => setTimeout(res, 900));
      }
    }
  } finally {
    certBusy = false;
  }
}

/** Public testnet RPC is rate-limited: fetch deeds a few at a time and render each row as it
 *  arrives, so a fresh visitor sees cards appear progressively instead of one blank wait. */
async function load(): Promise<void> {
  const config = await withBackoff(() => deedViews.config());
  if (token.contract !== config.payment_token) {
    const meta = await withBackoff(() => rpc.view<{ symbol: string; decimals: number }>(config.payment_token, "ft_metadata"));
    token = { contract: config.payment_token, symbol: meta.symbol, decimals: meta.decimals };
  }
  const all = await withBackoff(() => deedViews.deeds(0, 100));
  const wanted = [...all].sort((a, b) => Number(b.minted_at_ms) - Number(a.minted_at_ms)).slice(0, DETAIL_LIMIT);
  const me = currentAccount();
  rows = [];
  render();
  renderKpis();
  let next = 0;
  const lane = async (): Promise<void> => {
    const failed: DeedView[] = [];
    while (next < wanted.length) {
      const deed = wanted[next++];
      if (!deed) break;
      try {
        rows.push(await fetchRow(deed, me, false));
      } catch {
        failed.push(deed);
      }
      rows.sort((a, b) => b.stats.calls_30d - a.stats.calls_30d || b.stats.calls_total - a.stats.calls_total);
      render();
      renderKpis();
      await sleep(400);
    }
    for (const deed of failed) {
      try {
        rows.push(await withBackoff(() => fetchRow(deed, me, false)));
        rows.sort((a, b) => b.stats.calls_30d - a.stats.calls_30d || b.stats.calls_total - a.stats.calls_total);
        render();
        renderKpis();
      } catch {
        // truly unreadable: leave it out
      }
    }
  };
  await lane();
  void loadCerts();
}

async function refresh(): Promise<void> {
  try {
    await load();
    render();
    renderKpis();
    $("status").replaceChildren();
    $("status").className = "status";
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (rows.length > 0) status(`refresh hiccupped (${msg}); showing the last good read — retrying`, "quiet");
    else status(`could not read the chain: ${msg}`, "error");
  }
}

// ---------------------------------------------------------------- rendering

function figure(label: string, value: Child, title?: string): HTMLElement {
  return h("div", { class: "fig", ...(title ? { title } : {}) }, h("dt", {}, label), h("dd", {}, value));
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

function paybackText(r: Row): string {
  if (!r.deed.listing) return "not listed";
  const p = payback({
    price: BigInt(r.deed.listing.price),
    cash: BigInt(r.info.revenue),
    revenue30d: BigInt(r.stats.revenue_30d),
    gasSpent30dYocto: BigInt(r.stats.gas_spent_30d),
    vaultCreatedAtMs: Number(r.info.created_at_ms),
    nowMs: Date.now(),
    nearPrice: NEAR_PRICE_USD,
    tokenDecimals: token.decimals,
  });
  return p.paybackDays === null ? "never at current revenue" : `${p.paybackDays.toFixed(1)} days`;
}

function buyPanel(r: Row, me: string | null): { summary: string; body: HTMLElement } | null {
  const l = r.deed.listing;
  if (!l) return null;
  const panel = h("div", { class: "panel-body" });
  panel.append(
    h("p", { class: "note" }, `Listing #${l.listing_id} by ${l.seller} for `, h("span", { class: "num" }, `${amount(l.price)} ${token.symbol}`), l.active ? "." : " (activating)."),
    h("p", { class: "note" }, `The vault cash (${amount(r.info.revenue)} ${token.symbol}) comes with the deed. Customer credit stays owed to customers.`),
  );
  if (!me) panel.append(h("p", { class: "note" }, "Connect a wallet to buy."));
  else if (me === l.seller) {
    panel.append(button("Cancel listing", () => void act("Cancel listing", DEED_CONTRACT, [{ method: "cancel_listing", args: { token_id: r.deed.token_id }, gasTgas: 100, depositYocto: ONE_YOCTO }])));
  } else if (l.active) {
    const msg = JSON.stringify({ buy: { token_id: r.deed.token_id, max_price: l.price, listing_id: l.listing_id } });
    panel.append(
      button(`Buy for ${amount(l.price)} ${token.symbol}`, () => void act("Buy", token.contract, [{ method: "ft_transfer_call", args: { receiver_id: DEED_CONTRACT, amount: l.price, msg }, gasTgas: 250, depositYocto: ONE_YOCTO }]), "primary"),
      h("p", { class: "note" }, "The purchase is pinned to this listing id, so a cancelled and re-listed deed is refused and refunded."),
    );
  }
  return { summary: `For sale · ${amount(l.price)} ${token.symbol}`, body: panel };
}

function ownerPanel(r: Row): { summary: string; body: HTMLElement } {
  const v = r.deed.vault_id;
  const locked = r.info.locked;
  const panel = h("div", { class: "panel-body" });
  if (locked) panel.append(h("p", { class: "note" }, "The vault is locked while the deed is listed: no withdraw, rotation, config or price change."));
  if (!r.deed.listing) {
    panel.append(form([{ name: "price", placeholder: `price in ${token.symbol}` }], "List for sale", (f) => {
      const price = fromUnits(f.price ?? "", token.decimals).toString();
      void act("List", DEED_CONTRACT, [{ method: "list", args: { token_id: r.deed.token_id, price }, gasTgas: 100, depositYocto: ONE_YOCTO }]);
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
  return { summary: "Owner controls", body: panel };
}

function customerPanel(r: Row, me: string): { summary: string; body: HTMLElement } {
  const v = r.deed.vault_id;
  const c = r.me;
  const panel = h("div", { class: "panel-body" });
  if (c) {
    panel.append(
      h(
        "dl",
        { class: "figs small" },
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

/** Activity sparkline from the vault's day buckets: real on-chain history, no invention. */
function spark(days: { day: number; calls: number }[]): HTMLElement {
  const last = days.slice(-30);
  const max = Math.max(1, ...last.map((d) => d.calls));
  const dayDate = (day: number) => new Date(day * 86_400_000).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const bars = h("div", { class: "bars", role: "img", "aria-label": "calls per day, last 30 days" });
  for (const d of last) {
    bars.append(h("span", { class: "bar", style: `height:${Math.max(4, Math.round((d.calls / max) * 100))}%`, title: `${dayDate(d.day)} · ${d.calls} calls` }));
  }
  const first = last[0]?.day ?? 0;
  return h(
    "div",
    { class: "spark" },
    h("p", { class: "note", style: "margin:0" }, "Calls per day"),
    bars,
    h("p", { class: "cap" }, last.length > 0 ? `${dayDate(first)} – ${dayDate(last[last.length - 1]?.day ?? first)}` : "no activity yet"),
  );
}

function card(r: Row): HTMLElement {
  const me = currentAccount();
  const { deed, info, stats } = r;
  const img = r.token?.metadata?.media ? h("img", { class: "cert", src: r.token.metadata.media, alt: `Certificate of ${deed.title}` }) : h("div", { class: "cert empty" }, "no certificate");
  const pendingPrice = info.pending_price ? ` → ${amount(info.pending_price)} from ${new Date(Number(info.price_effective_at_ms)).toLocaleString()}` : "";
  const heroFigs = h(
    "dl",
    { class: "figs" },
    figure("calls, 30 days", h("span", { class: "num" }, String(stats.calls_30d))),
    figure("revenue, 30 days", h("span", { class: "num" }, `${amount(stats.revenue_30d)} `, h("span", { class: "unit" }, token.symbol))),
    figure("payback estimate", h("span", { class: "num" }, paybackText(r)), `Price minus cash, over net revenue per day (gas at ${NEAR_PRICE_USD} USD/NEAR)`),
  );
  const smallFigs = h(
    "dl",
    { class: "figs small" },
    figure("owner", link(`address/${info.owner_id}`, short(info.owner_id))),
    figure("price per call", h("span", { class: "num" }, `${amount(info.price_per_call, 6)} ${token.symbol}${pendingPrice}`)),
    figure("cash in vault", h("span", { class: "num" }, `${amount(info.revenue)} ${token.symbol}`), "Withdrawable revenue; goes to the buyer with the deed"),
    figure("customer credit", h("span", { class: "num" }, `${amount(info.liabilities)} ${token.symbol}`), "Prepaid by customers; never withdrawable by the owner"),
    figure("gas spent, 30 days", h("span", { class: "num" }, `${near(stats.gas_spent_30d, 5)} NEAR`), "Estimated from the vault's NEAR balance at each charge"),
    figure("customers", h("span", { class: "num" }, String(info.customers))),
    figure("calls, all time", h("span", { class: "num" }, String(stats.calls_total))),
    figure("revenue, all time", h("span", { class: "num" }, `${amount(stats.revenue_total)} ${token.symbol}`)),
    figure("worker key", h("span", { class: "num", title: info.worker_key ?? "" }, short(info.worker_key))),
    figure("endpoint", h("span", { class: "num" }, info.endpoint || "none")),
  );
  const head = h(
    "header",
    { class: "card-head" },
    h("h3", {}, deed.title),
    h(
      "p",
      { class: "meta" },
      link(`address/${deed.vault_id}`, deed.vault_id),
      ` · epoch ${info.owner_epoch} · minted ${new Date(Number(deed.minted_at_ms)).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`,
      info.locked ? h("span", { class: "tag quiet" }, "vault locked") : "",
      deed.listing ? h("span", { class: "tag" }, "for sale") : "",
    ),
  );
  const body = h("div", { class: "card-body" }, img, h("div", { class: "figures" }, heroFigs, spark(stats.days), smallFigs));
  const panels = [buyPanel(r, me), me && me === info.owner_id ? ownerPanel(r) : null, me ? customerPanel(r, me) : null].filter(
    (p): p is { summary: string; body: HTMLElement } => p !== null,
  );
  return h(
    "article",
    { class: "card" },
    head,
    body,
    ...panels.map((p) => h("details", { class: "panel" }, h("summary", {}, p.summary), p.body)),
  );
}

/** Live totals across all deeds, for the hero strip. */
function renderKpis(): void {
  const kpis = $("kpis");
  const calls30 = rows.reduce((n, r) => n + r.stats.calls_30d, 0);
  const rev30 = rows.reduce((n, r) => n + Number(r.stats.revenue_30d), 0);
  const callsAll = rows.reduce((n, r) => n + r.stats.calls_total, 0);
  kpis.replaceChildren(
    h("dl", { class: "fig" }, h("dt", {}, "businesses live"), h("dd", {}, String(rows.length))),
    h("dl", { class: "fig" }, h("dt", {}, "paid calls, 30 days"), h("dd", {}, String(calls30))),
    h("dl", { class: "fig" }, h("dt", {}, "revenue, 30 days"), h("dd", {}, amount(String(rev30)), h("span", { class: "unit" }, token.symbol))),
    h("dl", { class: "fig" }, h("dt", {}, "paid calls, all time"), h("dd", {}, String(callsAll))),
  );
}

function render(): void {
  const list = $("deeds");
  if (rows.length === 0) {
    list.replaceChildren(h("p", { class: "note" }, "No deeds yet."));
    return;
  }
  list.replaceChildren(...rows.map(card));
}

function renderWallet(account: string | null): void {
  const box = $("wallet");
  box.replaceChildren(
    account
      ? h("span", { class: "who" }, account)
      : h("span", { class: "who muted" }, "not connected"),
    account ? button("Disconnect", () => void disconnect()) : button("Connect wallet", () => void connect().catch((e) => status(String(e), "error")), "primary"),
  );
}

async function main(): Promise<void> {
  $("deed-link").replaceChildren(link(`address/${DEED_CONTRACT}`, DEED_CONTRACT));
  renderWallet(null);
  onAccount((a) => {
    renderWallet(a);
    void refresh();
  });
  await refresh();
  void initWallet().catch(() => undefined);
  setInterval(() => void refresh(), REFRESH_MS);
}

void main();
