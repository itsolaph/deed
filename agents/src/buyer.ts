#!/usr/bin/env node
// buyer: an agent that reads deed listings and vault views, computes trailing revenue, gas
// cost and payback, runs sanity checks, and buys with ft_transfer_call when payback is under
// a threshold. It prints its reasoning with the numbers.
//
//   node agents/dist/src/buyer.js --account deedlab-buyer.testnet --max-payback-days 30 \
//     [--token-id relay] [--fund-from eth:usdc --refund-to 0x...] [--dry-run]

import { parseArgs } from "node:util";
import {
  DeedViews,
  VaultViews,
  formatUnits,
  parsePublicKey,
  payback,
  toHex,
  type DeedView,
  type HealthResponse,
  type ListingView,
  type PaybackResult,
  type VaultInfo,
} from "@deed/sdk";
import { keychainFile, readKeyFile } from "@deed/sdk/node";
import { clock, ensureTusdc, isMain, loadDeployments, rpc, runMain, tokenBalance, tokenMeta, txLink, txSigner, writeJson } from "./common.js";
import { NEAR_USDC_ASSET, dryQuote, fetchTokens, findAsset, fundingQuoteRequest, nearPriceFrom } from "./oneclick.js";

const DEFAULT_NEAR_PRICE = 3;

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Evaluation {
  listing: ListingView;
  deed: DeedView;
  info: VaultInfo;
  calls30d: number;
  revenue30d: bigint;
  gas30d: bigint;
  result: PaybackResult;
  checks: Check[];
  decision: "buy" | "skip";
  why: string;
}

/** Pure decision rule, unit tested: every check must pass and payback must be under the bar. */
export function decide(result: PaybackResult, checks: Check[], maxPaybackDays: number): { decision: "buy" | "skip"; why: string } {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) return { decision: "skip", why: `failed checks: ${failed.map((c) => c.name).join(", ")}` };
  if (result.paybackDays === null) return { decision: "skip", why: "net revenue is not positive, it never pays back" };
  if (result.paybackDays > maxPaybackDays) return { decision: "skip", why: `payback ${result.paybackDays.toFixed(1)} days is over ${maxPaybackDays}` };
  return { decision: "buy", why: `payback ${result.paybackDays.toFixed(1)} days is under ${maxPaybackDays}` };
}

/** Checks that do not need the network beyond what was already read. */
export function staticChecks(listing: ListingView, deed: DeedView, info: VaultInfo, nowMs: number): Check[] {
  const pendingIncrease = info.pending_price !== null && BigInt(info.pending_price) > BigInt(info.price_per_call);
  return [
    { name: "listing active", ok: listing.active, detail: listing.active ? `listing #${listing.listing_id}` : "still activating" },
    { name: "seller owns the deed", ok: listing.seller === deed.owner_id && info.owner_id === deed.owner_id, detail: `deed owner ${deed.owner_id}, vault owner ${info.owner_id}` },
    { name: "vault locked for this listing", ok: info.locked && info.lock_id === listing.listing_id && info.owner_epoch === listing.epoch, detail: `locked=${info.locked} lock_id=${info.lock_id} epoch=${info.owner_epoch}` },
    {
      name: "no pending price increase",
      ok: !pendingIncrease,
      detail: pendingIncrease ? `price goes to ${info.pending_price} at ${new Date(Number(info.price_effective_at_ms)).toISOString()}` : `price ${info.price_per_call} per call`,
    },
    { name: "image hash set", ok: info.image_hash.trim().length > 0, detail: info.image_hash || "(empty)" },
    { name: "worker key registered", ok: info.worker_key !== null, detail: info.worker_key ?? "(none)" },
    { name: "has customers", ok: info.customers > 0, detail: `${info.customers} customers` },
    { name: "listing not stale", ok: nowMs - Number(listing.listed_at_ms) < 7 * 86_400_000, detail: `listed ${new Date(Number(listing.listed_at_ms)).toISOString()}` },
  ];
}

async function endpointCheck(info: VaultInfo): Promise<Check> {
  try {
    const res = await fetch(`${info.endpoint.replace(/\/+$/, "")}/v1/health`, { signal: AbortSignal.timeout(5000) });
    const h = (await res.json()) as HealthResponse;
    const ok = res.ok && h.vault !== undefined && h.worker_public_key === info.worker_key;
    return { name: "endpoint answers", ok, detail: ok ? `${info.endpoint} serves this vault with the registered worker key` : `${info.endpoint} answered ${res.status}` };
  } catch (e) {
    return { name: "endpoint answers", ok: false, detail: `${info.endpoint}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Mainnet implicit account controlled by the same ed25519 key (dry quote recipient only). */
function implicitAccountOf(publicKey: string): string {
  return toHex(parsePublicKey(publicKey));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      deed: { type: "string" },
      "token-id": { type: "string" },
      "max-payback-days": { type: "string", default: "30" },
      "near-price": { type: "string" },
      "fund-from": { type: "string" },
      "refund-to": { type: "string" },
      recipient: { type: "string" },
      "mint-if-short": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string" },
    },
  });
  const dep = loadDeployments();
  const account = values.account ?? dep.accounts.buyer;
  const deedId = values.deed ?? dep.accounts.deed;
  const maxPayback = Number(values["max-payback-days"]);
  const r = rpc();
  const deedViews = new DeedViews(r, deedId);
  const say = (line: string) => process.stdout.write(`${clock()} [buyer] ${line}\n`);

  say(`I am ${account}. I look for deeds on ${deedId} that pay back within ${maxPayback} days.`);
  const config = await deedViews.config();
  const token = await tokenMeta(r, config.payment_token);
  const fmt = (v: bigint | string) => `${formatUnits(v, token.decimals, 4)} ${token.symbol}`;

  let tokens: Awaited<ReturnType<typeof fetchTokens>> | null = null;
  let nearPrice = values["near-price"] ? Number(values["near-price"]) : NaN;
  if (Number.isNaN(nearPrice)) {
    try {
      tokens = await fetchTokens();
      nearPrice = nearPriceFrom(tokens) ?? DEFAULT_NEAR_PRICE;
      say(`NEAR price for gas costs: ${nearPrice} USD (1Click token list, read only)`);
    } catch {
      nearPrice = DEFAULT_NEAR_PRICE;
      say(`NEAR price for gas costs: ${nearPrice} USD (default, 1Click token list not reachable)`);
    }
  }

  const listings = (await deedViews.listings(0, 100)).filter((l) => !values["token-id"] || l.token_id === values["token-id"]);
  if (listings.length === 0) {
    say("no listings found. Nothing to buy.");
    writeJson(values.out, { decision: "none", reason: "no listings" });
    return;
  }

  const now = Date.now();
  const evaluations: Evaluation[] = [];
  for (const listing of listings) {
    if (listing.seller === account) continue;
    const deed = await deedViews.deedOf(listing.token_id);
    if (!deed) continue;
    const vault = new VaultViews(r, deed.vault_id);
    const [info, stats] = await Promise.all([vault.info(), vault.stats()]);
    const price = BigInt(listing.price);
    const cash = BigInt(info.revenue);
    const result = payback({
      price,
      cash,
      revenue30d: BigInt(stats.revenue_30d),
      gasSpent30dYocto: BigInt(stats.gas_spent_30d),
      vaultCreatedAtMs: Number(info.created_at_ms),
      nowMs: now,
      nearPrice,
      tokenDecimals: token.decimals,
    });
    const checks = [...staticChecks(listing, deed, info, now), await endpointCheck(info)];
    const { decision, why } = decide(result, checks, maxPayback);
    const ageMin = Math.round((now - Number(info.created_at_ms)) / 60_000);

    say(`--- ${listing.token_id} (${deed.title}) listed by ${listing.seller} for ${fmt(price)}, listing #${listing.listing_id}`);
    say(`vault ${deed.vault_id}: cash ${fmt(cash)} comes with the deed; customer credit ${fmt(info.liabilities)} stays owed to ${info.customers} customers`);
    say(`trailing 30 days: ${stats.calls_30d} calls, revenue ${fmt(stats.revenue_30d)}, gas ${formatUnits(BigInt(stats.gas_spent_30d), 24, 5)} NEAR (about ${(result.gasPerDay * result.windowDays).toFixed(4)} USD)`);
    say(`the vault is ${ageMin < 1440 ? `${ageMin} minutes` : `${(ageMin / 1440).toFixed(1)} days`} old, so I spread the figures over ${result.windowDays.toFixed(2)} day(s) (at least 1, at most 30)`);
    say(`per day: revenue ${result.revenuePerDay.toFixed(4)} - gas ${result.gasPerDay.toFixed(4)} = net ${result.netPerDay.toFixed(4)} ${token.symbol}`);
    say(
      `payback = (price ${formatUnits(price, token.decimals, 4)} - cash ${formatUnits(cash, token.decimals, 4)}) / net per day ${result.netPerDay.toFixed(4)} = ` +
        (result.paybackDays === null ? "never" : `${result.paybackDays.toFixed(2)} days`),
    );
    for (const c of checks) say(`check ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
    say(`decision: ${decision.toUpperCase()} (${why})`);
    evaluations.push({ listing, deed, info, calls30d: stats.calls_30d, revenue30d: BigInt(stats.revenue_30d), gas30d: BigInt(stats.gas_spent_30d), result, checks, decision, why });
  }

  const pick = evaluations.filter((e) => e.decision === "buy").sort((a, b) => (a.result.paybackDays ?? Infinity) - (b.result.paybackDays ?? Infinity))[0];
  const report: Record<string, unknown> = {
    account,
    deed: deedId,
    near_price_usd: nearPrice,
    max_payback_days: maxPayback,
    evaluated: evaluations.map((e) => ({
      token_id: e.listing.token_id,
      listing_id: e.listing.listing_id,
      price: e.listing.price,
      cash: e.info.revenue,
      calls_30d: e.calls30d,
      revenue_30d: e.revenue30d.toString(),
      gas_spent_30d_yocto: e.gas30d.toString(),
      window_days: e.result.windowDays,
      net_per_day: e.result.netPerDay,
      payback_days: e.result.paybackDays,
      checks: e.checks,
      decision: e.decision,
      why: e.why,
    })),
  };

  if (values["fund-from"] && pick) {
    try {
      tokens ??= await fetchTokens();
      const origin = findAsset(tokens, values["fund-from"]);
      if (!values["refund-to"]) throw new Error(`--refund-to <address on ${origin.blockchain}> is needed for a quote`);
      const buyerKey = readKeyFile(keychainFile(account)).public_key;
      const recipient = values.recipient ?? implicitAccountOf(buyerKey);
      const req = fundingQuoteRequest({ originAsset: origin.assetId, destinationAsset: NEAR_USDC_ASSET, amountOut: BigInt(pick.listing.price), recipient, refundTo: values["refund-to"] });
      const q = await dryQuote(req);
      say(`funding from ${values["fund-from"]} with NEAR Intents 1Click (dry quote, mainnet, nothing is deposited):`);
      say(`  pay ${q.quote.amountInFormatted} ${origin.symbol} on ${origin.blockchain} (about ${q.quote.amountInUsd} USD) -> receive ${q.quote.amountOutFormatted} USDC on NEAR at ${recipient}`);
      say(`  estimated time ${q.quote.timeEstimate} s; a real run would deposit to the address of a non-dry quote, then buy with the USDC.`);
      say(`  on testnet the purchase below uses ${token.symbol} instead; the quote shows the cross-chain leg only.`);
      report.funding_quote = { request: req, quote: q.quote, timestamp: q.timestamp, correlation_id: q.correlationId ?? null };
    } catch (e) {
      say(`funding quote failed: ${e instanceof Error ? e.message : String(e)}`);
      report.funding_quote_error = e instanceof Error ? e.message : String(e);
    }
  }

  if (!pick) {
    say("nothing passes my rules. Not buying.");
    report.decision = "skip";
    writeJson(values.out, report);
    return;
  }
  report.decision = "buy";
  report.token_id = pick.listing.token_id;
  report.vault = pick.deed.vault_id;
  if (values["dry-run"]) {
    say(`dry run: I would buy ${pick.listing.token_id} for ${fmt(pick.listing.price)}.`);
    writeJson(values.out, report);
    return;
  }

  const price = BigInt(pick.listing.price);
  if (values["mint-if-short"]) await ensureTusdc(r, config.payment_token, account, price);
  const balance = await tokenBalance(r, config.payment_token, account);
  if (balance < price) throw new Error(`not enough ${token.symbol}: have ${fmt(balance)}, need ${fmt(price)}`);

  const msg = JSON.stringify({ buy: { token_id: pick.listing.token_id, max_price: price.toString(), listing_id: pick.listing.listing_id } });
  say(`buying: ft_transfer_call ${fmt(price)} to ${deedId} with msg ${msg}`);
  const tx = await txSigner(account).call(config.payment_token, {
    method: "ft_transfer_call",
    args: { receiver_id: deedId, amount: price.toString(), msg },
    gasTgas: 250,
    depositYocto: 1n,
  });
  const after = await deedViews.deedOf(pick.listing.token_id);
  const vaultAfter = await new VaultViews(r, pick.deed.vault_id).info();
  const bought = after?.owner_id === account && vaultAfter.owner_id === account;
  say(`${bought ? "bought" : "purchase did not go through"}: ${txLink(tx.hash)}`);
  say(`deed owner now ${after?.owner_id}, vault owner now ${vaultAfter.owner_id} (epoch ${vaultAfter.owner_epoch}, locked ${vaultAfter.locked})`);
  report.buy_tx = tx.hash;
  report.buy_link = txLink(tx.hash);
  report.bought = bought;
  writeJson(values.out, report);
  if (!bought) process.exitCode = 1;
}

if (isMain(import.meta.url)) runMain("buyer", main);
