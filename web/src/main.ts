// Deed web app: every deed on the deed contract with live numbers from the contract views,
// its dynamic NFT certificate, and the actions for buyers, owners and customers.

import "./style.css";
import { Rpc, TESTNET_RPC_URLS } from "../../sdk/src/chain.js";
import { formatUnits, fromUnits, payback } from "../../sdk/src/payback.js";
import { DeedViews, VaultViews, type CustomerView, type DeedView, type NftToken, type VaultInfo, type VaultStatsView } from "../../sdk/src/views.js";
import { DEED_CONTRACT, EXPLORER, NEAR_PRICE_USD, REFRESH_MS } from "./config";
import { connect, currentAccount, disconnect, initWallet, onAccount, send, type Call } from "./wallet";

const rpc = new Rpc(TESTNET_RPC_URLS);
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

function status(text: string, kind: "info" | "ok" | "error" = "info", txHash?: string | null): void {
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

async function load(): Promise<void> {
  const config = await deedViews.config();
  if (token.contract !== config.payment_token) {
    const meta = await rpc.view<{ symbol: string; decimals: number }>(config.payment_token, "ft_metadata");
    token = { contract: config.payment_token, symbol: meta.symbol, decimals: meta.decimals };
  }
  const deeds = await deedViews.deeds(0, 100);
  const me = currentAccount();
  rows = await Promise.all(
    deeds.map(async (deed) => {
      const vault = new VaultViews(rpc, deed.vault_id);
      const [info, stats, nft, mine] = await Promise.all([
        vault.info(),
        vault.stats(),
        deedViews.token(deed.token_id),
        me ? vault.customer(me) : Promise.resolve(null),
      ]);
      return { deed, info, stats, token: nft, me: mine };
    }),
  );
  // Newest first.
  rows.sort((a, b) => Number(b.deed.minted_at_ms) - Number(a.deed.minted_at_ms));
}

async function refresh(): Promise<void> {
  try {
    await load();
    render();
    $("updated").textContent = `updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    status(`could not read the chain: ${e instanceof Error ? e.message : String(e)}`, "error");
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

function buyPanel(r: Row, me: string | null): HTMLElement | null {
  const l = r.deed.listing;
  if (!l) return null;
  const panel = h("section", { class: "panel" }, h("h4", {}, "For sale"));
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
  return panel;
}

function ownerPanel(r: Row): HTMLElement {
  const v = r.deed.vault_id;
  const locked = r.info.locked;
  const panel = h("section", { class: "panel" }, h("h4", {}, "You own this business"));
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
  return panel;
}

function customerPanel(r: Row, me: string): HTMLElement {
  const v = r.deed.vault_id;
  const c = r.me;
  const panel = h("section", { class: "panel" }, h("h4", {}, "Your relay credit"));
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
  return panel;
}

function card(r: Row): HTMLElement {
  const me = currentAccount();
  const { deed, info, stats } = r;
  const img = r.token?.metadata?.media ? h("img", { class: "cert", src: r.token.metadata.media, alt: `Certificate of ${deed.title}` }) : h("div", { class: "cert empty" }, "no certificate");
  const pendingPrice = info.pending_price ? ` → ${amount(info.pending_price)} from ${new Date(Number(info.price_effective_at_ms)).toLocaleString()}` : "";
  const figs = h(
    "dl",
    { class: "figs" },
    figure("owner", link(`address/${info.owner_id}`, info.owner_id)),
    figure("price per call", h("span", { class: "num" }, `${amount(info.price_per_call, 6)} ${token.symbol}${pendingPrice}`)),
    figure("calls, 30 days", h("span", { class: "num" }, String(stats.calls_30d))),
    figure("revenue, 30 days", h("span", { class: "num" }, `${amount(stats.revenue_30d)} ${token.symbol}`)),
    figure("gas spent, 30 days", h("span", { class: "num" }, `${near(stats.gas_spent_30d, 5)} NEAR`), "Estimated from the vault's NEAR balance at each charge"),
    figure("cash in vault", h("span", { class: "num" }, `${amount(info.revenue)} ${token.symbol}`), "Withdrawable revenue; goes to the buyer with the deed"),
    figure("customer credit", h("span", { class: "num" }, `${amount(info.liabilities)} ${token.symbol}`), "Prepaid by customers; never withdrawable by the owner"),
    figure("customers", h("span", { class: "num" }, String(info.customers))),
    figure("worker key", h("span", { class: "num", title: info.worker_key ?? "" }, short(info.worker_key))),
    figure("endpoint", h("span", { class: "num" }, info.endpoint || "none")),
    figure("listed at", h("span", { class: "num" }, deed.listing ? `${amount(deed.listing.price)} ${token.symbol}` : "not listed")),
    figure("payback estimate", h("span", { class: "num" }, paybackText(r)), `Price minus cash, over net revenue per day (gas at ${NEAR_PRICE_USD} USD/NEAR)`),
  );
  const head = h(
    "header",
    { class: "card-head" },
    h("h3", {}, deed.title),
    h("p", { class: "meta" }, link(`address/${deed.vault_id}`, deed.vault_id), ` · epoch ${info.owner_epoch}`, info.locked ? " · locked" : "", deed.listing ? h("span", { class: "tag" }, "for sale") : ""),
  );
  const panels = h("div", { class: "panels" });
  const buy = buyPanel(r, me);
  if (buy) panels.append(buy);
  if (me && me === info.owner_id) panels.append(ownerPanel(r));
  if (me) panels.append(customerPanel(r, me));
  return h("article", { class: "card" }, head, h("div", { class: "card-body" }, img, figs), panels);
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
