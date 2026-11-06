#!/usr/bin/env node
// buyer: an agent that reads token listings and vault views, attributes the vault's revenue to
// independent customers (owners, previous owners and owner-funded customers excluded, see
// sdk/src/appraisal.ts), computes payback on chain-visible costs, runs its checks, and buys with
// ft_transfer_call when every check passes and payback is under a threshold. It prints every
// check with pass/fail and the reason.
//
//   node agents/dist/src/buyer.js --account outlive-buyer.testnet --max-payback-days 30 \
//     [--policy strict|demo] [--min-customers n] [--max-share 0..1] [--min-age-hours h] \
//     [--token-id relay] [--fund-from eth:usdc --refund-to 0x...] [--dry-run]
//
// Policies: strict (default): 3 independent paying customers, none above 60% of independent
// revenue, vault at least 72 h old. demo: 2 customers, 80%, 0 h, for the 10-minute testnet demo;
// the agent says so every time it is used. Every override flag is printed too.

import { parseArgs } from "node:util";
import {
  DAY_MS,
  DEMO_POLICY_NOTICE,
  OutliveViews,
  PAYBACK_COSTS_NOTE,
  PAYBACK_LABEL,
  STATS_WINDOW_DAYS,
  TESTNET_TX_API,
  TxIndex,
  VaultViews,
  appraise,
  describePolicy,
  formatUnits,
  ownersFromEvents,
  parsePublicKey,
  payback,
  policyByName,
  readFunding,
  readVaultHistory,
  revenueByCustomer,
  toHex,
  type Appraisal,
  type AppraisalPolicy,
  type Check,
  type OutliveView,
  type FundingRecord,
  type HealthResponse,
  type ListingView,
  type PaybackResult,
  type VaultInfo,
} from "@outlive/sdk";
import { keychainFile, readKeyFile } from "@outlive/sdk/node";
import { clock, ensureTusdc, isMain, loadDeployments, rpc, runMain, tokenBalance, tokenMeta, txLink, txSigner, withRpcRetry, writeJson } from "./common.js";
import { DRY_QUOTE_LABEL, NEAR_USDC_ASSET, dryQuote, fetchTokens, findAsset, fundingQuoteRequest, nearPriceFrom } from "./oneclick.js";

export type { Check };

const DEFAULT_NEAR_PRICE = 3;
/** Customers whose funding is read per listing; any beyond count as unverified. */
const MAX_FUNDING_READS = 25;
/** Vault transaction batches (20 each) read for the appraisal. */
const MAX_HISTORY_BATCHES = 25;

export interface Evaluation {
  listing: ListingView;
  outlive: OutliveView;
  info: VaultInfo;
  calls30d: number;
  revenue30d: bigint;
  independentRevenue30d: bigint;
  gas30d: bigint;
  result: PaybackResult;
  appraisal: Appraisal | null;
  checks: Check[];
  decision: "buy" | "skip";
  why: string;
}

/** Pure decision rule, unit tested: every check must pass and payback must be under the bar. */
export function decide(result: PaybackResult, checks: Check[], maxPaybackDays: number): { decision: "buy" | "skip"; why: string } {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) return { decision: "skip", why: `failed checks: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")}` };
  if (result.paybackDays === null) return { decision: "skip", why: "net independent revenue is not positive, it never pays back" };
  if (result.paybackDays > maxPaybackDays) return { decision: "skip", why: `${PAYBACK_LABEL} ${result.paybackDays.toFixed(1)} days is over ${maxPaybackDays}` };
  return { decision: "buy", why: `${PAYBACK_LABEL} ${result.paybackDays.toFixed(1)} days is under ${maxPaybackDays}` };
}

/** The policy from --policy plus explicit overrides; every override is listed, none is hidden. */
export function resolvePolicy(
  name: string,
  overrides: { minCustomers?: string | undefined; maxShare?: string | undefined; minAgeHours?: string | undefined },
): { policy: AppraisalPolicy; overridden: string[] } {
  const policy = policyByName(name);
  const overridden: string[] = [];
  const num = (v: string, flag: string, ok: (n: number) => boolean): number => {
    const n = Number(v);
    if (!Number.isFinite(n) || !ok(n)) throw new Error(`bad ${flag} ${v}`);
    overridden.push(`${flag} ${v}`);
    return n;
  };
  if (overrides.minCustomers !== undefined) policy.minCustomers = num(overrides.minCustomers, "--min-customers", (n) => Number.isInteger(n) && n >= 1);
  if (overrides.maxShare !== undefined) policy.maxShare = num(overrides.maxShare, "--max-share", (n) => n > 0 && n <= 1);
  if (overrides.minAgeHours !== undefined) policy.minAgeHours = num(overrides.minAgeHours, "--min-age-hours", (n) => n >= 0);
  if (overridden.length > 0) policy.name = `${policy.name} with overrides`;
  return { policy, overridden };
}

/** Checks that do not need the network beyond what was already read. */
export function staticChecks(listing: ListingView, outlive: OutliveView, info: VaultInfo, nowMs: number): Check[] {
  const pendingIncrease = info.pending_price !== null && BigInt(info.pending_price) > BigInt(info.price_per_call);
  return [
    { name: "listing active", ok: listing.active, detail: listing.active ? `listing #${listing.listing_id}` : "still activating" },
    { name: "seller owns the token", ok: listing.seller === outlive.owner_id && info.owner_id === outlive.owner_id, detail: `token owner ${outlive.owner_id}, vault owner ${info.owner_id}` },
    { name: "vault locked for this listing", ok: info.locked && info.lock_id === listing.listing_id && info.owner_epoch === listing.epoch, detail: `locked=${info.locked} lock_id=${info.lock_id} epoch=${info.owner_epoch}` },
    {
      name: "no pending price increase",
      ok: !pendingIncrease,
      detail: pendingIncrease ? `price goes to ${info.pending_price} at ${new Date(Number(info.price_effective_at_ms)).toISOString()}` : `price ${info.price_per_call} per call`,
    },
    { name: "image hash set", ok: info.image_hash.trim().length > 0, detail: info.image_hash || "(empty)" },
    { name: "worker key registered", ok: info.worker_key !== null, detail: info.worker_key ?? "(none)" },
    { name: "listing not stale", ok: nowMs - Number(listing.listed_at_ms) < 7 * 86_400_000, detail: `listed ${new Date(Number(listing.listed_at_ms)).toISOString()}` },
  ];
}

async function endpointCheck(info: VaultInfo): Promise<Check> {
  try {
    const res = await fetch(`${info.endpoint.replace(/\/+$/, "")}/v1/health`, { signal: AbortSignal.timeout(8000) });
    const h = (await res.json()) as HealthResponse;
    const ok = res.ok && h.vault !== undefined && h.worker_public_key === info.worker_key;
    return { name: "endpoint answers", ok, detail: ok ? `${info.endpoint} serves this vault with the registered worker key` : `${info.endpoint} answered ${res.status}` };
  } catch (e) {
    return { name: "endpoint answers", ok: false, detail: `${info.endpoint}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Reads the vault's events and the funding of every paying customer, then appraises. */
async function appraiseVault(
  index: TxIndex,
  listing: ListingView,
  info: VaultInfo,
  vault: string,
  revenue30d: bigint,
  token: string,
  policy: AppraisalPolicy,
  nowMs: number,
  say: (line: string) => void,
): Promise<Appraisal> {
  const hist = await readVaultHistory(index, vault, undefined, { maxBatches: MAX_HISTORY_BATCHES, settleMs: 0, nowMs });
  say(`event log: ${hist.listed} vault transactions in the index, ${hist.listed - hist.unread} read (${hist.requests} requests to ${new URL(index.baseUrl).host})`);
  const excluded = new Set([info.owner_id, listing.seller, vault, info.outlive_id, ...ownersFromEvents(hist.events)]);
  const paying = [...revenueByCustomer(hist.events, nowMs - STATS_WINDOW_DAYS * DAY_MS, nowMs).keys()].filter((c) => !excluded.has(c));
  const funding = new Map<string, FundingRecord>();
  for (const customer of paying.slice(0, MAX_FUNDING_READS)) {
    try {
      const f = await readFunding(index, customer, token);
      funding.set(customer, { funders: f.funders, complete: f.complete });
    } catch (e) {
      say(`funding of ${customer} not readable (${e instanceof Error ? e.message : String(e)}); it counts as unverified`);
    }
  }
  return appraise(
    { vault, outlive: info.outlive_id, owner: info.owner_id, alsoExcluded: [listing.seller], events: hist.events, funding, revenue30d, vaultCreatedAtMs: Number(info.created_at_ms), nowMs, ownerEpoch: info.owner_epoch },
    policy,
  );
}

/** Mainnet implicit account controlled by the same ed25519 key (dry quote recipient only). */
function implicitAccountOf(publicKey: string): string {
  return toHex(parsePublicKey(publicKey));
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      account: { type: "string" },
      outlive: { type: "string" },
      "token-id": { type: "string" },
      "max-payback-days": { type: "string", default: "30" },
      policy: { type: "string", default: "strict" },
      "min-customers": { type: "string" },
      "max-share": { type: "string" },
      "min-age-hours": { type: "string" },
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
  const outliveId = values.outlive ?? dep.accounts.outlive;
  const maxPayback = Number(values["max-payback-days"]);
  const r = rpc();
  const index = new TxIndex(process.env.OUTLIVE_TX_INDEX || TESTNET_TX_API);
  const outliveViews = new OutliveViews(r, outliveId);
  const say = (line: string) => process.stdout.write(`${clock()} [buyer] ${line}\n`);
  const { policy, overridden } = resolvePolicy(values.policy!, { minCustomers: values["min-customers"], maxShare: values["max-share"], minAgeHours: values["min-age-hours"] });

  say(`I am ${account}. I look for tokens on ${outliveId} whose ${PAYBACK_LABEL} is within ${maxPayback} days.`);
  say(`policy ${describePolicy(policy)}`);
  if (values.policy === "demo") say(DEMO_POLICY_NOTICE);
  if (overridden.length > 0) say(`policy overrides given on the command line: ${overridden.join(", ")}`);
  say(`${PAYBACK_LABEL}: ${PAYBACK_COSTS_NOTE}.`);
  const config = await outliveViews.config();
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

  const listings = (await outliveViews.listings(0, 100)).filter((l) => !values["token-id"] || l.token_id === values["token-id"]);
  if (listings.length === 0) {
    say("no listings found. Nothing to buy.");
    writeJson(values.out, { decision: "none", reason: "no listings", policy });
    return;
  }

  const now = Date.now();
  const evaluations: Evaluation[] = [];
  for (const listing of listings) {
    if (listing.seller === account) continue;
    const outlive = await outliveViews.outliveOf(listing.token_id);
    if (!outlive) continue;
    const vault = new VaultViews(r, outlive.vault_id);
    const [info, stats] = await Promise.all([vault.info(), vault.stats()]);
    const price = BigInt(listing.price);
    const cash = BigInt(info.revenue);
    say(`--- ${listing.token_id} (${outlive.title}) listed by ${listing.seller} for ${fmt(price)}, listing #${listing.listing_id}`);
    say(`vault ${outlive.vault_id}: withdrawable proceeds (cash) ${fmt(cash)} come with the token; customer credit ${fmt(info.liabilities)} is owed to ${info.customers} customers and is not withdrawable`);
    say(`trailing 30 days per the vault: ${stats.calls_30d} calls, revenue ${fmt(stats.revenue_30d)}, gas ${formatUnits(BigInt(stats.gas_spent_30d), 24, 5)} NEAR`);

    let appraisal: Appraisal | null = null;
    const checks: Check[] = staticChecks(listing, outlive, info, now);
    try {
      appraisal = await appraiseVault(index, listing, info, outlive.vault_id, BigInt(stats.revenue_30d), config.payment_token, policy, now, say);
      for (const c of appraisal.customers) {
        say(`  customer ${c.customer}: ${c.calls} paid calls, ${fmt(c.revenue)} -> ${c.class === "independent" ? "counted" : `NOT counted (${c.class})`}: ${c.reason}`);
      }
      const x = appraisal.excluded;
      say(`independent revenue ${fmt(appraisal.independentRevenue)}; not counted: owner ${fmt(x.owner)}, owner-funded ${fmt(x.ownerFunded)}, unverified ${fmt(x.unverified)}, not in the event log ${fmt(x.unattributed)}`);
      checks.push(...appraisal.checks);
    } catch (e) {
      checks.push({ name: "revenue attributable to customers", ok: false, detail: `the event log could not be read (${e instanceof Error ? e.message : String(e)}), so no revenue is counted` });
    }
    checks.push(await endpointCheck(info));

    const independent = appraisal?.independentRevenue ?? 0n;
    const result = payback({
      price,
      cash,
      revenue30d: independent,
      gasSpent30dYocto: BigInt(stats.gas_spent_30d),
      vaultCreatedAtMs: Number(info.created_at_ms),
      nowMs: now,
      nearPrice,
      tokenDecimals: token.decimals,
    });
    const { decision, why } = decide(result, checks, maxPayback);
    const ageMin = Math.round((now - Number(info.created_at_ms)) / 60_000);
    say(`the vault is ${ageMin < 1440 ? `${ageMin} minutes` : `${(ageMin / 1440).toFixed(1)} days`} old, so I spread the figures over ${result.windowDays.toFixed(2)} day(s) (at least 1, at most 30)`);
    say(`per day: independent revenue ${result.revenuePerDay.toFixed(4)} - on-chain gas ${result.gasPerDay.toFixed(4)} = net ${result.netPerDay.toFixed(4)} ${token.symbol} (hosting, bandwidth and operator time not included)`);
    say(
      `${PAYBACK_LABEL} = (price ${formatUnits(price, token.decimals, 4)} - cash ${formatUnits(cash, token.decimals, 4)}) / net per day ${result.netPerDay.toFixed(4)} = ` +
        (result.paybackDays === null ? "never" : `${result.paybackDays.toFixed(2)} days`),
    );
    for (const c of checks) say(`check ${c.ok ? "pass" : "FAIL"} ${c.name}: ${c.detail}`);
    say(`decision: ${decision.toUpperCase()} (${why})`);
    evaluations.push({
      listing,
      outlive,
      info,
      calls30d: stats.calls_30d,
      revenue30d: BigInt(stats.revenue_30d),
      independentRevenue30d: independent,
      gas30d: BigInt(stats.gas_spent_30d),
      result,
      appraisal,
      checks,
      decision,
      why,
    });
  }

  const pick = evaluations.filter((e) => e.decision === "buy").sort((a, b) => (a.result.paybackDays ?? Infinity) - (b.result.paybackDays ?? Infinity))[0];
  const report: Record<string, unknown> = {
    account,
    outlive: outliveId,
    near_price_usd: nearPrice,
    max_payback_days: maxPayback,
    policy,
    policy_overrides: overridden,
    payback_basis: `${PAYBACK_LABEL}: ${PAYBACK_COSTS_NOTE}`,
    evaluated: evaluations.map((e) => ({
      token_id: e.listing.token_id,
      listing_id: e.listing.listing_id,
      price: e.listing.price,
      cash: e.info.revenue,
      customer_credit: e.info.liabilities,
      calls_30d: e.calls30d,
      revenue_30d: e.revenue30d.toString(),
      independent_revenue_30d: e.independentRevenue30d.toString(),
      excluded: e.appraisal ? Object.fromEntries(Object.entries(e.appraisal.excluded).map(([k, v]) => [k, v.toString()])) : null,
      customers: e.appraisal?.customers.map((c) => ({ customer: c.customer, payer: c.payer, calls: c.calls, revenue: c.revenue.toString(), class: c.class, reason: c.reason })) ?? null,
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
      say(`funding from ${values["fund-from"]} with NEAR Intents 1Click: ${DRY_QUOTE_LABEL}:`);
      say(`  would pay ${q.quote.amountInFormatted} ${origin.symbol} on ${origin.blockchain} (about ${q.quote.amountInUsd} USD) -> would receive ${q.quote.amountOutFormatted} USDC on NEAR at ${recipient}`);
      say(`  estimated time ${q.quote.timeEstimate} s. No deposit address exists for a dry quote; nothing was sent or swapped.`);
      say(`  on testnet the purchase below uses ${token.symbol} instead; the quote only prices the cross-chain leg.`);
      report.funding_quote = { label: DRY_QUOTE_LABEL, request: req, quote: q.quote, timestamp: q.timestamp, correlation_id: q.correlationId ?? null };
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
  report.vault = pick.outlive.vault_id;
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
  say(`buying: ft_transfer_call ${fmt(price)} to ${outliveId} with msg ${msg}`);
  const tx = await withRpcRetry(() => txSigner(account).call(config.payment_token, {
    method: "ft_transfer_call",
    args: { receiver_id: outliveId, amount: price.toString(), msg },
    gasTgas: 250,
    depositYocto: 1n,
  }), 4, (line) => say(`  ${line}`));
  const after = await outliveViews.outliveOf(pick.listing.token_id);
  const vaultAfter = await new VaultViews(r, pick.outlive.vault_id).info();
  const bought = after?.owner_id === account && vaultAfter.owner_id === account;
  say(`${bought ? "bought" : "purchase did not go through"}: ${txLink(tx.hash)}`);
  say(`token owner now ${after?.owner_id}, vault owner now ${vaultAfter.owner_id} (epoch ${vaultAfter.owner_epoch}, locked ${vaultAfter.locked})`);
  report.buy_tx = tx.hash;
  report.buy_link = txLink(tx.hash);
  report.bought = bought;
  writeJson(values.out, report);
  if (!bought) process.exitCode = 1;
}

if (isMain(import.meta.url)) runMain("buyer", main);
