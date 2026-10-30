# Security

This is a self-review by the authors, not an independent audit. Nobody outside the project
has checked these contracts. Treat the deployment as testnet software and do not put real
money into it.

## Scope

The three contracts in `contracts/` (`deed`, `vault`, `tusdc`), reviewed in October 2026
before the hackathon submission. The worker, SDK, agents and web app were not part of that
review; their threat model and known limits are in [DESIGN.md](DESIGN.md#threat-model-off-chain-parts).
The worker's outbound requests are guarded against server-side request forgery and covered by
tests (`worker/test/`), but that code has had no outside review either.

We read every contract method looking for: state changed after a promise instead of before,
callbacks that do not restore state on failure, missing `#[private]`, predecessor versus
signer confusion, a wrong token accepted in `ft_on_transfer`, rounding and overflow, storage
draining and griefing, gas starvation in callbacks, ways for a seller to withdraw, rotate or
reprice while listed, epoch and receipt-ordering bugs, `nft_transfer_call` edge cases,
refund-window races, what a leaked worker key can do, admin powers, and anything that breaks
the vault balance invariant.

## Fixed

Each fix has a sandbox test in `contracts/tests/tests/integration/review.rs` that failed
before the fix.

| Severity | Issue | Fix |
|---|---|---|
| High | Any deposit for an existing customer cancelled their refund request. With `deposit_for` and one unit of the token, anyone (for example the owner) could stop a customer from ever leaving while the worker kept charging up to the daily cap. | Only the customer's own deposit cancels their request. A deposit by someone else is added to the balance and refunded with it. |
| Medium | A cap decrease applied at once, so a customer could set the cap to zero before the next charge batch and never pay for calls already served, then take a refund. | A cap decrease waits for the refund delay. A raise still applies at once. |
| Medium | A buyer's only protection was `max_price`. A seller could cancel, withdraw the vault's cash and re-list at the same price while a purchase was on its way. Also, `lock` and `unlock` only carried the owner epoch, so a late unlock from an earlier listing could in theory unlock a vault with an active listing if receipts arrived out of order. | Every listing gets an increasing `listing_id`, which is also the vault lock id. Buyers can pin it in the buy message. The vault only accepts a newer lock id and only unlocks for the id that locked it. A still-activating listing can now be cancelled, so a lost callback cannot leave a token stuck. |
| Low | `sync_vault` during a pending `nft_transfer_call` pushed the not-yet-final receiver. | Refused while a transfer call is pending. |
| Low | A token could be transferred to the deed contract or to its own vault, which can never use the owner powers. | Refused. |
| Low | Stats pushes that arrived out of order could overwrite newer figures. | Older pushes are ignored. |

## Main remaining risks

- **The deed account key.** On testnet the deed account keeps a full-access key so the code
  can be redeployed. Whoever holds it can replace the deed code, push a fake owner to every
  vault, withdraw revenue and register a worker key that charges customers within their caps.
  Vaults cannot be upgraded, but they trust their parent deed. For mainnet the deed account's
  full-access keys must be removed, or upgrades must go through a DAO with a delay.
- **The owner runs the worker.** The worker key can charge customers within their balance and
  daily cap without serving them. Signed receipts make this visible; caps and the refund delay
  limit it. Customers should keep low caps and small balances.
- **Revenue figures can be inflated.** An owner can pay their own business to make the 30-day
  calls and revenue look better before a sale. A buyer should look at the customer count and
  the deposit history, not only the totals.
- **The seller's worker key after a sale.** It keeps working until the buyer rotates it. Its
  charges go to the buyer, but it can still mis-charge customers within caps and burn its
  remaining gas allowance (default 0.5 NEAR, at most 5 NEAR) from the vault's NEAR. Buyers
  should rotate right after buying.
- **The vault's NEAR balance.** Customer entries, worker gas and state growth are paid from
  the vault's NEAR. If it runs low, new deposits and charges fail until someone calls
  `fund_gas`. The minimum first deposit (1 unit of a 6-decimal token) makes storage spam cost
  money, but it assumes a 6-decimal payment token.
- **Off-chain claims.** The endpoint and image hash are claims by the owner. Nothing on chain
  proves which code the worker runs. TEE attestation is roadmap.
- **`nft_transfer_call`.** Until `nft_resolve_transfer` pushes the final owner, the sender keeps
  the owner powers on the vault. Receiver contracts should not rely on the vault's cash
  during `nft_on_transfer`.
- **Mint refunds.** If the vault creation batch fails, the deed refunds the full deposit right
  away from its own balance, before the batch's NEAR comes back to it. A deed account without
  spare NEAR could fail that refund. Validation runs before the batch, and no test could make
  the batch fail.
- **tUSDC** is a testnet faucet token with no value. Never deploy it on mainnet.

## Reporting

Please open an issue in the repository. Do not include private keys or other secrets.
