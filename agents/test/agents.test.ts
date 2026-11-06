import assert from "node:assert/strict";
import { test } from "node:test";
import { generateSecretKey, payback, sha256Hex, signOutbound, signerFromSecretKey, type OutliveView, type ListingView, type VaultInfo } from "@outlive/sdk";

import { decide, resolvePolicy, staticChecks } from "../src/buyer.js";
import { startEchoTarget } from "../src/echo-target.js";
import { NEAR_USDC_ASSET, dryQuote, findAsset, fundingQuoteRequest, nearPriceFrom, payoutQuoteRequest, type OneClickToken } from "../src/oneclick.js";
import { withdrawCommand } from "../src/withdraw-xchain.js";

const TOKENS: OneClickToken[] = [
  { assetId: "nep141:wrap.near", decimals: 24, blockchain: "near", symbol: "wNEAR", price: 4.2 },
  { assetId: NEAR_USDC_ASSET, decimals: 6, blockchain: "near", symbol: "USDC", price: 1 },
  { assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near", decimals: 6, blockchain: "eth", symbol: "USDC", price: 1 },
];

const listing: ListingView = { token_id: "relay", listing_id: 3, seller: "seller.testnet", price: "5000000", active: true, epoch: 1, listed_at_ms: String(Date.now()) };
const outlive = { token_id: "relay", title: "Relay", owner_id: "seller.testnet", owner_epoch: 1, vault_id: "relay.outlive.testnet", price_at_mint: "10000", minted_at_ms: "0", stats: null, listing, transfer_call_pending: false } satisfies OutliveView;
const info: VaultInfo = {
  outlive_id: "outlive.testnet",
  token_id: "relay",
  owner_id: "seller.testnet",
  owner_epoch: 1,
  locked: true,
  lock_id: 3,
  payment_token: "tusdc.testnet",
  price_per_call: "10000",
  pending_price: null,
  price_effective_at_ms: null,
  endpoint: "http://127.0.0.1:7601",
  image_hash: "sha256:abc",
  worker_key: "ed25519:x",
  revenue: "1000000",
  liabilities: "9000000",
  in_flight: "0",
  customers: 2,
  charged_items: "100",
  default_daily_cap: "100000000",
  min_deposit: "1000000",
  refund_delay_sec: 600,
  stats_interval_sec: 600,
  near_balance: "0",
  created_at_ms: "0",
};

test("buyer: buys only when every check passes and payback is under the bar", () => {
  const now = Date.now();
  const good = payback({ price: 5_000_000n, cash: 1_000_000n, revenue30d: 2_000_000n, gasSpent30dYocto: 0n, vaultCreatedAtMs: now - 3_600_000, nowMs: now, nearPrice: 4, tokenDecimals: 6 });
  assert.equal(good.windowDays, 1);
  assert.equal(good.paybackDays, 2);
  const checks = staticChecks(listing, outlive, info, now);
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks.filter((c) => !c.ok)));
  assert.equal(decide(good, checks, 30).decision, "buy");
  assert.equal(decide(good, checks, 1).decision, "skip");

  const priceUp = staticChecks(listing, outlive, { ...info, pending_price: "20000", price_effective_at_ms: String(now + 1000) }, now);
  assert.match(decide(good, priceUp, 30).why, /no pending price increase/);
  const unlocked = staticChecks(listing, outlive, { ...info, locked: false }, now);
  assert.match(decide(good, unlocked, 30).why, /vault locked/);
  const relisted = staticChecks(listing, outlive, { ...info, lock_id: 4 }, now);
  assert.equal(decide(good, relisted, 30).decision, "skip");
  const noImage = staticChecks(listing, outlive, { ...info, image_hash: "" }, now);
  assert.equal(decide(good, noImage, 30).decision, "skip");
  const losing = payback({ price: 5_000_000n, cash: 0n, revenue30d: 0n, gasSpent30dYocto: 10n ** 24n, vaultCreatedAtMs: 0, nowMs: now, nearPrice: 4, tokenDecimals: 6 });
  assert.match(decide(losing, checks, 30).why, /never pays back/);
  assert.match(decide(good, checks, 30).why, /payback on chain-visible costs 2\.0 days/);
});

test("buyer: a failed appraisal gate skips with its reason, and policies print their overrides", () => {
  const now = Date.now();
  const good = payback({ price: 5_000_000n, cash: 0n, revenue30d: 5_000_000n, gasSpent30dYocto: 0n, vaultCreatedAtMs: now - 3_600_000, nowMs: now, nearPrice: 4, tokenDecimals: 6 });
  const gate = { name: "independent paying customers", ok: false, detail: "0 independent of 2 paying customers, need 2; revenue from owner-funded customers excluded" };
  const d = decide(good, [...staticChecks(listing, outlive, info, now), gate], 30);
  assert.equal(d.decision, "skip");
  assert.match(d.why, /independent paying customers \(0 independent of 2 .*revenue from owner-funded customers excluded\)/);

  const strict = resolvePolicy("strict", {});
  assert.deepEqual([strict.policy.minCustomers, strict.policy.maxShare, strict.policy.minAgeHours, strict.overridden], [3, 0.6, 72, []]);
  const demo = resolvePolicy("demo", {});
  assert.deepEqual([demo.policy.minCustomers, demo.policy.maxShare, demo.policy.minAgeHours], [2, 0.8, 0]);
  const custom = resolvePolicy("strict", { minAgeHours: "24" });
  assert.equal(custom.policy.minAgeHours, 24);
  assert.equal(custom.policy.name, "strict with overrides");
  assert.deepEqual(custom.overridden, ["--min-age-hours 24"]);
  assert.throws(() => resolvePolicy("strict", { maxShare: "1.5" }), /bad --max-share/);
});

test("1Click: asset lookup, NEAR price and dry quote requests", async () => {
  assert.equal(findAsset(TOKENS, "eth:usdc").assetId, TOKENS[2]!.assetId);
  assert.throws(() => findAsset(TOKENS, "doge:usdc"), /does not list/);
  assert.throws(() => findAsset(TOKENS, "usdc"), /<chain>:<symbol>/);
  assert.equal(nearPriceFrom(TOKENS), 4.2);

  const fund = fundingQuoteRequest({ originAsset: TOKENS[2]!.assetId, destinationAsset: NEAR_USDC_ASSET, amountOut: 5_000_000n, recipient: "ab".repeat(32), refundTo: "0x000000000000000000000000000000000000dEaD", now: 0 });
  assert.equal(fund.dry, true);
  assert.equal(fund.swapType, "EXACT_OUTPUT");
  assert.equal(fund.amount, "5000000");
  assert.equal(fund.deadline, new Date(30 * 60 * 1000).toISOString());
  const payout = payoutQuoteRequest({ destinationAsset: TOKENS[2]!.assetId, amountIn: 7n, recipient: "0xabc", refundTo: "owner.near" });
  assert.equal(payout.originAsset, NEAR_USDC_ASSET);
  assert.equal(payout.swapType, "EXACT_INPUT");

  let sent: unknown;
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ timestamp: "t", signature: "s", quoteRequest: sent, quote: { amountIn: "5010000", amountInFormatted: "5.01", amountInUsd: "5.01", minAmountIn: "5000000", amountOut: "5000000", amountOutFormatted: "5", amountOutUsd: "5", minAmountOut: "5000000", timeEstimate: 20 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const q = await dryQuote(fund, fakeFetch);
  assert.equal(q.quote.amountInFormatted, "5.01");
  assert.equal((sent as { dry: boolean }).dry, true);
  await assert.rejects(dryQuote({ ...fund, dry: false } as unknown as typeof fund, fakeFetch), /only asks for dry quotes/);
});

test("withdraw-xchain prints the exact vault call", () => {
  const cmd = withdrawCommand({ vault: "relay.outlive.testnet", owner: "buyer.testnet", amount: 1_500_000n, receiver: "deposit.near", network: "testnet" });
  assert.match(cmd, /relay\.outlive\.testnet withdraw json-args '\{"amount":"1500000","receiver_id":"deposit\.near","memo":"1Click payout"\}'/);
  assert.match(cmd, /attached-deposit '1 yoctoNEAR' sign-as buyer\.testnet/);
});

test("echo target fails on purpose and checks the relay signature", async () => {
  let n = 0;
  const lines: string[] = [];
  const { server, stats } = await startEchoTarget({ port: 7630, failRate: 0.5, random: () => (n++ % 2 === 0 ? 0.1 : 0.9), log: (l) => lines.push(l) });
  try {
    const signer = signerFromSecretKey(generateSecretKey().secretKey);
    const body = '{"x":1}';
    const send = async (attempt: number, sign = true) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (sign) Object.assign(headers, signOutbound(signer, { vault: "v.testnet", deliveryId: "d_1", attempt, timestamp: 1, method: "POST", path: "/hook?a=1", bodySha256: sha256Hex(body) }));
      return (await fetch("http://127.0.0.1:7630/hook?a=1", { method: "POST", headers, body })).status;
    };
    assert.equal(await send(1), 503);
    assert.equal(await send(2), 200);
    assert.equal(await send(1, false), 503);
    assert.equal(stats.badSignature, 1);
    assert.equal(stats.ok, 1);
    assert.ok(lines.some((l) => /relay-sig ok/.test(l)));
    assert.ok(lines.some((l) => /relay-sig BAD/.test(l)));
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});
