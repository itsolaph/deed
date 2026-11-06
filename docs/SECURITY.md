# Security

This is a self-review by the authors, not an independent audit. Nobody outside the project
has checked these contracts. Treat the deployment as testnet software and do not put real
money into it.

## Scope

The initial self-review covered the three contracts in `contracts/` (`outlive`, `vault`,
`tusdc`). A subsequent engineering pass covered worker admission, charging, handover, receipt
binding, journal recovery and buyer funding checks; regression tests for those fixes are listed
below. Neither pass is an independent security audit. The off-chain threat model and limits are
in [DESIGN.md](DESIGN.md#threat-model-off-chain-parts).
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
| Low | A token could be transferred to the Outlive contract or to its own vault, which can never use the owner powers. | Refused. |
| Low | Stats pushes that arrived out of order could overwrite newer figures. | Older pushes are ignored. |

## Off-chain regression fixes

- **Concurrent takeover:** customer resubmission and a signed worker handoff could admit the
  same delivery more than once. A shared per-delivery promise now serializes admission after
  each caller's input has been authenticated (`worker/test/hardening.test.ts`).
- **Incomplete receipt binding:** URL and body hashes alone did not authenticate method,
  headers or idempotency key. Receipt v2 signs a canonical complete-request hash; modified and
  legacy unbound resubmissions are rejected. This intentionally breaks takeover of v1 receipts;
  drain old obligations before upgrading (`worker/test/hardening.test.ts`).
- **Ambiguous charge responses:** thrown, malformed or incomplete responses could strand a
  batch or settle it without evidence. The batch stays retryable with its original sequences;
  an already applied charge comes back as `duplicate` (`worker/test/hardening.test.ts`).
- **Retirement during admission:** a customer RPC read could finish after the charger stopped
  and still reserve a charge. Admission checks retirement again after the read.
- **Idempotency conflicts:** the same key with different request content now returns HTTP 409,
  including concurrent requests, rather than a misleading successful receipt.
- **Journal crash recovery:** a torn final line could swallow the next accepted record on
  replay. Startup repairs only the torn tail, fails closed on corrupt complete records, and
  appends are synchronized (`worker/test/journal.test.ts`).
- **Buyer verification:** endpoint health must identify the exact vault and an accepting,
  healthy worker. Non-finite payback values cannot authorize a purchase. Missing transaction
  bodies mark funding history incomplete rather than independently funded
  (`agents/test/agents.test.ts`, `sdk/test/appraisal.test.ts`).

## Main remaining risks

- **The contract account key.** On testnet the token account keeps a full-access key so the code
  can be redeployed. Whoever holds it can replace the token code, push a fake owner to every
  vault, withdraw revenue and register a worker key that charges customers within their caps.
  Vaults cannot be upgraded, but they trust their parent contract. For mainnet the token account's
  full-access keys must be removed, or upgrades must go through a DAO with a delay.
- **Price at settlement.** The immutable vault charges at the on-chain price when a batch
  executes, not at the `price` quoted in an earlier receipt. A delayed batch can cross a
  scheduled increase; a decrease can also change the final debit. The receipt is not a
  contract-enforced price lock. Keep customer caps and balances small, and drain pending
  work before changing prices. Exact accepted-price settlement requires a new vault API;
  an off-chain timing check cannot guarantee it for an already submitted transaction.
- **Overlapping key rotations.** `set_worker` publishes proposed key/history before its
  key-action callback. A conditional failure-order trace can leave a proposed predecessor
  advertised even though it was never installed. The full failure/interleaving has not been
  reproduced on chain. Serialize rotations through complete transaction finality and verify
  both `get_info` and the account's actual access keys before starting the replacement worker.
  Existing vaults are immutable; an operator workaround is not a contract-level fix.
- **The owner runs the worker.** The worker key can charge customers within their balance and
  daily cap without serving them. Signed receipts make this visible; caps and the refund delay
  limit it. Customers should keep low caps and small balances.
- **Revenue figures can be inflated.** An owner can pay their own business to make the 30-day
  calls and revenue look better before a sale. The vault's totals include such revenue. The
  buyer agent counts only revenue it can attribute to independent customers: owners now and
  before, the listing seller, the vault, the token and customers funded by any of them (one hop:
  `deposit_for`, transfers, account creation, sub-accounts) are excluded, and its default policy
  wants 3 independent payers, none above 60%, and 72 hours of history
  ([DESIGN.md](DESIGN.md#buyer-agent)). `scripts/wash-reject.mjs` shows a rejection on testnet.
  Funding through an intermediary account, or a seller recruiting real third parties, is not
  caught.
- **The seller's worker key after a sale.** It keeps working until the buyer rotates it. Its
  charges go to the buyer, but it can still mis-charge customers within caps and burn its
  remaining gas allowance (default 0.5 NEAR, at most 5 NEAR) from the vault's NEAR. Buyers
  should rotate right after buying.
- **A hostile seller kills its worker.** No hand-off, no flush. Customers keep their receipts and
  resubmit them to the buyer's worker: charged jobs are delivered without a second charge,
  uncharged ones are charged once, and unspent credit stays refundable. A charged job whose
  receipt the customer lost is paid for and never delivered; there is no clawback. Details and a
  testnet run: [DESIGN.md](DESIGN.md#hostile-seller-the-old-worker-is-killed-not-handed-off),
  `scripts/hostile-seller.sh`.
- **The vault's NEAR balance.** Customer entries, worker gas and state growth are paid from
  the vault's NEAR. If it runs low, new deposits and charges fail until someone calls
  `fund_gas`. The minimum first deposit (1 unit of a 6-decimal token) makes storage spam cost
  money, but it assumes a 6-decimal payment token.
- **Off-chain claims.** The endpoint and image hash are claims by the owner. Nothing on chain
  proves which code the worker runs. TEE attestation is roadmap.
- **`nft_transfer_call`.** Until `nft_resolve_transfer` pushes the final owner, the sender keeps
  the owner powers on the vault. Receiver contracts should not rely on the vault's cash
  during `nft_on_transfer`.
- **Mint refunds.** If the vault creation batch fails, the token refunds the full deposit right
  away from its own balance, before the batch's NEAR comes back to it. A contract account without
  spare NEAR could fail that refund. Validation runs before the batch, and no test could make
  the batch fail.
- **tUSDC** is a testnet faucet token with no value. Never deploy it on mainnet.

## Reporting

Please open an issue in the repository. Do not include private keys or other secrets.
