// NEAR Intents 1Click API, dry quotes only.
// Docs: https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
// A dry quote ("dry": true) creates no deposit address and starts no swap. This project never
// asks for a real quote and never deposits: on testnet there is nothing to swap.

export const ONECLICK_BASE = "https://1click.chaindefuser.com";
/** Native USDC on NEAR mainnet (6 decimals). */
export const NEAR_USDC_ASSET = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const QUOTE_DEADLINE_MS = 30 * 60 * 1000;

export interface OneClickToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  price: number;
  priceUpdatedAt?: string;
  contractAddress?: string;
}

export interface QuoteRequest {
  dry: true;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN" | "INTENTS";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN" | "INTENTS";
  recipient: string;
  recipientType: "DESTINATION_CHAIN" | "INTENTS";
  deadline: string;
}

export interface QuoteResponse {
  correlationId?: string;
  timestamp: string;
  signature: string;
  quoteRequest: QuoteRequest;
  quote: {
    depositAddress?: string;
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    minAmountIn: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    timeEstimate: number;
  };
}

export async function fetchTokens(fetchImpl: typeof fetch = fetch): Promise<OneClickToken[]> {
  const res = await fetchImpl(`${ONECLICK_BASE}/v0/tokens`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`1Click tokens: HTTP ${res.status}`);
  return (await res.json()) as OneClickToken[];
}

/** Finds an asset by "<chain>:<symbol>", for example "eth:usdc" or "sol:usdc". */
export function findAsset(tokens: OneClickToken[], spec: string): OneClickToken {
  const [chain, symbol] = spec.toLowerCase().split(":");
  if (!chain || !symbol) throw new Error(`asset must look like <chain>:<symbol>, got ${spec}`);
  const hit = tokens.find((t) => t.blockchain.toLowerCase() === chain && t.symbol.toLowerCase() === symbol);
  if (!hit) throw new Error(`1Click does not list ${spec}`);
  return hit;
}

export function nearPriceFrom(tokens: OneClickToken[]): number | null {
  const wnear = tokens.find((t) => t.assetId === "nep141:wrap.near");
  return wnear && wnear.price > 0 ? wnear.price : null;
}

/** Quote for paying `amountOut` of `destinationAsset` to `recipient`, funded from another chain. */
export function fundingQuoteRequest(opts: {
  originAsset: string;
  destinationAsset: string;
  amountOut: bigint;
  recipient: string;
  refundTo: string;
  now?: number;
}): QuoteRequest {
  return {
    dry: true,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: opts.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: opts.destinationAsset,
    amount: opts.amountOut.toString(),
    refundTo: opts.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: opts.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((opts.now ?? Date.now()) + QUOTE_DEADLINE_MS).toISOString(),
  };
}

/** Quote for sending `amountIn` of NEAR USDC (vault revenue) to `recipient` on another chain. */
export function payoutQuoteRequest(opts: {
  destinationAsset: string;
  amountIn: bigint;
  recipient: string;
  refundTo: string;
  now?: number;
}): QuoteRequest {
  return {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: NEAR_USDC_ASSET,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: opts.destinationAsset,
    amount: opts.amountIn.toString(),
    refundTo: opts.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: opts.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date((opts.now ?? Date.now()) + QUOTE_DEADLINE_MS).toISOString(),
  };
}

export async function dryQuote(req: QuoteRequest, fetchImpl: typeof fetch = fetch): Promise<QuoteResponse> {
  if (req.dry !== true) throw new Error("this tool only asks for dry quotes");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.ONECLICK_API_KEY) headers["x-api-key"] = process.env.ONECLICK_API_KEY;
  const res = await fetchImpl(`${ONECLICK_BASE}/v0/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => null)) as (QuoteResponse & { message?: string }) | null;
  if (!res.ok || !body?.quote) throw new Error(`1Click quote: HTTP ${res.status} ${body?.message ?? JSON.stringify(body)}`);
  return body;
}
