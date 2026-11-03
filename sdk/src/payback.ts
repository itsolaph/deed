// Payback math for a listed deed. Used by the buyer agent and the web app. Pure functions.
//
// "Payback on chain-visible costs": net per day is revenue per day minus the vault's on-chain
// gas per day. Hosting, bandwidth and operator time are off chain and NOT included, so the
// figure is a lower bound on the real payback time. The buyer agent feeds it independent revenue
// only (see appraisal.ts); the web board shows it on all revenue and says so.

export const PAYBACK_LABEL = "payback on chain-visible costs";
export const PAYBACK_COSTS_NOTE = "net per day = revenue minus on-chain gas; hosting, bandwidth and operator time are not included";

export const DAY_MS = 86_400_000;
export const STATS_WINDOW_DAYS = 30;
const YOCTO_PER_NEAR = 10n ** 24n;

export interface PaybackInput {
  /** Listing price in the payment token's smallest unit. */
  price: bigint;
  /** Withdrawable revenue in the vault, which goes to the buyer with the deed. */
  cash: bigint;
  revenue30d: bigint;
  /** yoctoNEAR the vault spent on gas in the last 30 days. */
  gasSpent30dYocto: bigint;
  vaultCreatedAtMs: number;
  nowMs: number;
  /** Price of 1 NEAR in payment-token units (whole tokens), for example 3.0 for USD tokens. */
  nearPrice: number;
  tokenDecimals: number;
}

export interface PaybackResult {
  /** Days the 30-day figures cover: the vault's age, at least 1 and at most 30. */
  windowDays: number;
  revenuePerDay: number;
  gasPerDay: number;
  netPerDay: number;
  /** Price minus the cash that comes with the vault, never below zero. */
  netPrice: number;
  /** null when net revenue is not positive (never pays back). */
  paybackDays: number | null;
}

export function toUnits(amount: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

export function fromUnits(amount: string | number, decimals: number): bigint {
  const text = String(amount).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`bad amount ${text}`);
  const [whole = "0", frac = ""] = text.split(".");
  if (frac.length > decimals) throw new Error(`more than ${decimals} decimals in ${text}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function formatUnits(amount: bigint | string, decimals: number, maxFraction = decimals): string {
  const value = typeof amount === "string" ? BigInt(amount) : amount;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  let frac = (abs % scale).toString().padStart(decimals, "0").slice(0, maxFraction);
  frac = frac.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function yoctoToNear(yocto: bigint): number {
  return toUnits(yocto, 24);
}

export function windowDays(vaultCreatedAtMs: number, nowMs: number): number {
  const age = (nowMs - vaultCreatedAtMs) / DAY_MS;
  return Math.min(STATS_WINDOW_DAYS, Math.max(1, age));
}

export function payback(input: PaybackInput): PaybackResult {
  const days = windowDays(input.vaultCreatedAtMs, input.nowMs);
  const revenue = toUnits(input.revenue30d, input.tokenDecimals);
  const gas = (Number(input.gasSpent30dYocto) / Number(YOCTO_PER_NEAR)) * input.nearPrice;
  const revenuePerDay = revenue / days;
  const gasPerDay = gas / days;
  const netPerDay = revenuePerDay - gasPerDay;
  const netPriceUnits = input.price > input.cash ? input.price - input.cash : 0n;
  const netPrice = toUnits(netPriceUnits, input.tokenDecimals);
  const paybackDays = netPerDay > 0 ? netPrice / netPerDay : null;
  return { windowDays: days, revenuePerDay, gasPerDay, netPerDay, netPrice, paybackDays };
}
