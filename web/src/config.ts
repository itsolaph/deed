// Testnet configuration. `?outlive=<account>` in the URL selects another Outlive contract.

const params = new URLSearchParams(location.search);

export const NETWORK = "testnet" as const;
export const OUTLIVE_CONTRACT = params.get("outlive") || "outlive3.outlive.testnet";
export const EXPLORER = "https://testnet.nearblocks.io";
/** Transaction index for the earnings history (FastNEAR; NearBlocks' testnet indexer lags). */
export const TX_INDEX = params.get("tx_index") || "https://tx.test.fastnear.com";
/** Gas is paid in NEAR, revenue in a USD token: payback needs a NEAR price. A fixed
 * assumption keeps the page free of third-party calls; the buyer agent uses a live one. */
export const NEAR_PRICE_USD = Number(params.get("near_usd") || 3);
export const REFRESH_MS = 30_000;
export const TGAS = 1_000_000_000_000n;
