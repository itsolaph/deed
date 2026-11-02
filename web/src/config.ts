// Testnet configuration. `?deed=<account>` in the URL selects another deed contract.

const params = new URLSearchParams(location.search);

export const NETWORK = "testnet" as const;
export const DEED_CONTRACT = params.get("deed") || "deed2.deedlab.testnet";
export const EXPLORER = "https://testnet.nearblocks.io";
/** Gas is paid in NEAR, revenue in a USD token: payback needs a NEAR price. A fixed
 * assumption keeps the page free of third-party calls; the buyer agent uses a live one. */
export const NEAR_PRICE_USD = Number(params.get("near_usd") || 3);
export const REFRESH_MS = 30_000;
export const TGAS = 1_000_000_000_000n;
