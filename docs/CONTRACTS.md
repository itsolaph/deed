# Contracts

Three contracts live in `contracts/`:

| Contract | Testnet account | Role |
|---|---|---|
| `deed` | `deed.deedlab.testnet` | NEP-171 registry. Mints one token per business, creates its vault, runs the built-in sale. |
| `vault` | `<slug>.deed.deedlab.testnet` | One per business. Treasury, price list, customer ledger, worker key. |
| `tusdc` | `tusdc.deedlab.testnet` | Testnet-only test token (NEP-141). Has no value. |

All amounts are `u128` in the payment token's smallest unit (tUSDC and USDC have 6 decimals)
and are passed as JSON strings. Arithmetic on balances is checked. Every state change that
matters emits a NEP-297 event (`EVENT_JSON:` log) with standard `deed`, version `1.0.0`.
Token moves also emit the standard NEP-171 `nft_mint` and `nft_transfer` events.

Deployed code hashes and every testnet transaction are listed in
[`deployments/testnet.json`](../deployments/testnet.json).

## deed

### Init

`new(admin_id, payment_token, payment_symbol?)`. Private: only the deed account itself can
call it (deploy and init go in one batch). `payment_token` is the NEP-141 used for listing
prices and vault credit (tUSDC on testnet, native USDC on mainnet). `payment_symbol` is only
used for display in the certificate.

### Mint

`mint(slug, title, price_per_call, endpoint, image_hash, default_daily_cap)`, payable.

- `slug` is `[a-z0-9-]`, 2 to 32 characters, no leading, trailing or doubled hyphen, not taken
  (also not by a mint in flight), and `<slug>.<deed account>` must fit in 64 characters.
- The attached deposit must be at least `mint_cost()`: vault code storage
  (1 NEAR per 100 KB, about 2.3 NEAR for the current vault), 0.05 NEAR vault state,
  0.5 NEAR starting gas tank for the vault, 0.01 NEAR for the token record in the deed and
  0.00125 NEAR for registering the vault on the payment token. On testnet this is 2.857 NEAR.
- One batch on the new account: create account, transfer, deploy vault code, call vault
  `new`. No access key is added. The token (`token_id = slug`) is minted to the caller only in
  the callback after the batch succeeded. If the batch failed, the whole batch reverted and
  the callback returns the full deposit. On success the excess deposit is refunded and the
  deed registers the vault on the payment token.
- The vault wasm is embedded in the deed at build time (`scripts/build.sh` builds the vault
  first). `vault_code_hash()` returns its sha256 (hex and base58) so anyone can compare it
  with the code hash of any `<slug>.deed.deedlab.testnet` on an explorer.

Scale note: NEP-591 global contracts (deploy once, reference by hash) are the way to run many
vaults. Publishing a global contract burns about 10 NEAR per 100 KB once, so for a handful of
deeds plain per-vault deployment is cheaper. This version deploys per vault.

### NFT standards

- NEP-171 core: `nft_transfer`, `nft_transfer_call`, `nft_resolve_transfer`, `nft_token`.
- NEP-177 metadata: `nft_metadata`. Token metadata is built on the fly in every view:
  `title`, `description`, `media` (a `data:image/svg+xml;base64` certificate showing the
  title, vault, price per call, trailing 30-day calls and revenue, cash in the vault,
  customer credit held, the holder and the time of the last stats update), `updated_at`,
  and `extra` (the stats JSON pushed by the vault).
- NEP-181 enumeration: `nft_total_supply`, `nft_tokens`, `nft_supply_for_owner`,
  `nft_tokens_for_owner`.
- No NEP-178 approvals. `nft_transfer` with an `approval_id` fails. The built-in sale is the
  only sale path, so a seller cannot list the token on an outside marketplace (where the
  vault would not be locked) and drain the vault right before that sale settles.

### Ownership push

After every final ownership change the deed increments the token's `owner_epoch` and calls
`vault.set_owner(new_owner, epoch)`:

- mint: the vault starts with the minter at epoch 1 (set by `new`);
- `nft_transfer`: right away;
- `nft_transfer_call`: only in `nft_resolve_transfer`, once the final owner is known
  (also when the token goes back to the sender);
- sale: in the purchase itself.

The vault ignores any epoch that is not newer than its own, so pushes that arrive out of order
cannot roll the owner back. `sync_vault(token_id)` (anyone, payable) re-pushes the current
owner and epoch, for example after a push ran out of gas. A failed push emits
`deed_owner_push_failed`. Transfers are refused while the token is listed.

### Sale

- `list(token_id, price)`: owner only, 1 yocto. Stores a pending listing and asks the vault
  to `lock(epoch)`. The listing becomes active only in the callback after the lock
  succeeded. If the lock failed (for example the vault has a different epoch), the listing is
  removed.
- `cancel_listing(token_id)`: seller only, 1 yocto, active listings only. Removes the listing
  and unlocks the vault. `unlock_vault(token_id)` lets the owner re-send the unlock if it was
  lost.
- Buy: `ft_transfer_call` on the payment token to the deed with
  `msg = {"buy":{"token_id":"...","max_price":"..."}}`. The deed checks that the call came
  from the payment token, that the listing is active and matches the current owner and epoch,
  that the price is at most `max_price` and at most the amount sent, and that the buyer is not
  the seller. Then it removes the listing, moves the token, pushes the new owner (the vault
  unlocks on the newer epoch), pays the seller with `ft_transfer` and returns the unused
  amount to the buyer. Any refusal returns the full amount and emits `deed_buy_refused`.
- If paying the seller fails (for example the seller is not registered on the token), the
  amount is kept in the deed as claimable proceeds (`proceeds_of`, `claim_proceeds()`).
  A failed claim restores the proceeds.

### Stats

`on_stats(token_id, stats)` is accepted only from that token's vault account. It stores the
latest figures, which the metadata views render.

### Views

`mint_cost`, `vault_code_hash`, `get_config`, `get_deed`, `get_deeds`, `get_listings`,
`proceeds_of`, plus the NEP-171/177/181 views.

### Admin powers

`admin_id` is stored and shown by `get_config`. It has no on-chain powers in this version:
it cannot move tokens, cannot withdraw anything, cannot change or lock a vault and cannot
change the payment token. There is no admin method at all.

What is not trustless: the deed account `deed.deedlab.testnet` holds a full-access key, so
whoever holds that key can redeploy the deed code on testnet. Redeployed code could push a
fake owner to every vault (the vault trusts its parent deed). On mainnet the deed account's
full-access keys should be removed after deployment, or upgrades should go through a DAO.
Vaults themselves cannot be upgraded: they hold no full-access key and have no upgrade method.

### Deed events

`deed_vault_created`, `deed_mint_failed`, `deed_owner_pushed`, `deed_owner_push_failed`,
`deed_listed`, `deed_listing_active`, `deed_listing_failed`, `deed_listing_cancelled`,
`deed_sold`, `deed_buy_refused`, `deed_seller_paid`, `deed_proceeds_held`,
`deed_proceeds_claimed`, `deed_stats`, plus NEP-171 `nft_mint` and `nft_transfer`.

## vault

### Init

`new(token_id, owner_id, payment_token, price_per_call, endpoint, image_hash,
default_daily_cap, refund_delay_sec?, stats_interval_sec?)`. Only the parent account may call
it (the predecessor must equal the part of the vault account id after the first dot), and
it runs inside the creation batch. The refund delay defaults to 10 minutes and is at most
1 hour. It is fixed at init. The stats push interval defaults to 10 minutes.

### Keys

The vault account never gets a full-access key. The only key it ever holds is the current
worker key, which the vault adds itself in `set_worker`: a function-call key with
receiver = the vault, methods = `["charge"]` and a capped allowance (default 0.5 NEAR,
at most 5 NEAR). The integration tests and the testnet smoke run check the access-key list.

### Customer credit

- `ft_on_transfer` accepts only the configured payment token (predecessor check). Empty
  `msg` credits the sender, `{"deposit_for":"<account>"}` credits another account. Anything
  else panics, so the token refunds the transfer.
- A new customer's first deposit must be at least 1 tUSDC (`MIN_CUSTOMER_DEPOSIT`), so
  creating ledger entries costs real money. The vault pays the storage of a customer entry
  from its NEAR balance and frees it when the customer is fully refunded.
- A new deposit cancels a pending refund request.

### Ledger

Per customer: `balance`, `daily_cap`, `spent_today`, `day` (UTC day number), `last_seq`,
`refund_requested_at`. Totals: `liabilities` (sum of customer balances, never withdrawable),
`revenue` (withdrawable by the owner) and `in_flight` (sent with `ft_transfer`, waiting for
the callback).

New customer entries start with `last_seq` equal to the total number of charge items applied
so far. That value is at least any seq the same account had before a full refund removed its
entry, so old receipts can never be charged again after a customer comes back.

### Charge

`charge(items: [{customer, seq, units, receipts_root}])`, 1 to 40 items.

- Callable only by a transaction signed as the vault account itself
  (predecessor == current account) with the registered worker key
  (`signer_account_pk == worker_key`).
- Per item: `seq <= last_seq` is reported as `duplicate` and never charged twice;
  `seq > last_seq + 1` is `seq_gap`; `units` must be positive; cost = units * price must fit
  the balance (`insufficient_balance`) and the remaining daily cap for the UTC day
  (`over_daily_cap`); unknown customers and malformed roots are reported too. A failed item
  changes nothing. A charged item moves the cost from the customer's balance to revenue.
- `receipts_root` (hex sha256 over that batch's delivery receipts) goes into the
  `vault_charge` event only, not into storage.
- Updates 30 daily stat buckets (calls, revenue, gas spent).
- If the last stats push is older than the push interval, it calls `deed.on_stats` with
  10 Tgas and no callback. A failed push never fails the charge.

### Owner methods

All need 1 yocto, are owner only and are refused while the vault is locked:

- `withdraw(amount, receiver_id?, memo?)`: at most `revenue`. Sends `ft_transfer` to the
  receiver (default the owner). A receiver lets the owner pay out to a NEAR Intents 1Click
  deposit address for a cross-chain withdrawal. The callback restores revenue on failure.
- `set_worker(public_key, allowance?)`: deletes the previous worker key and adds the new
  function-call key in one batch. The callback restores the previous state if the batch
  failed. The last 10 worker keys are kept in `get_worker_history()` with the time and owner
  epoch, so clients can verify receipts signed by earlier workers.
- `set_config(endpoint, image_hash)`.
- `set_price(price)`: a decrease (or the current price) applies at once and drops a scheduled
  increase. An increase applies only after 24 hours (`pending_price`,
  `price_effective_at_ms`), so customers can leave first.

### Customer methods

`set_daily_cap(amount)`, `request_refund()`, and after the refund delay `claim_refund()`,
which pays out the whole remaining balance. During the delay the worker can still charge
calls it already served. The gateway (worker) stops serving a customer with a pending refund.
A failed refund transfer restores the balance and the request.

### Deed hooks

`lock(epoch)`, `unlock(epoch)` and `set_owner(new_owner, epoch)` accept calls only from the
deed. `lock` needs the epoch to equal the vault's current epoch. `set_owner` with a newer
epoch replaces the owner and clears the lock; older or equal epochs are ignored.

### Gas cost tracking

The worker key's transactions are paid from the vault's own NEAR balance. The vault measures
this approximately: at every `charge` it compares its account balance with the balance it
recorded at the end of the previous measurement. A drop is added to today's `gas_spent`, a
rise (gas refunds arrive a little later) is subtracted, never below zero. NEAR sent with
`fund_gas()` is excluded. Plain NEAR transfers to the vault without `fund_gas` show up as
negative gas spending, so top up through `fund_gas`. The figure is an estimate of the net gas
cost, good enough for a buyer's payback math, not an accounting record.

### Views

`get_info()` (owner, epoch, locked, token, deed, payment token, price, pending price, endpoint,
image hash, worker key, revenue, liabilities, in flight, customers, refund delay and more),
`get_customer(account_id)`, `get_stats()` (30-day calls, revenue, gas spent, daily buckets,
lifetime totals), `get_push_stats()`, `get_worker_history()`.

### Vault events

`vault_init`, `vault_deposit`, `vault_charge`, `vault_withdraw`, `vault_withdraw_failed`,
`vault_worker_set`, `vault_worker_set_failed`, `vault_config`, `vault_price`,
`vault_price_scheduled`, `vault_daily_cap`, `vault_refund_requested`, `vault_refund`,
`vault_refund_failed`, `vault_lock`, `vault_unlock`, `vault_owner`, `vault_owner_ignored`,
`vault_gas_funded`.

## tusdc

NEP-141 with NEP-145 storage management and NEP-148 metadata: name "Test USDC", symbol
`tUSDC`, 6 decimals. `mint(amount)` lets anyone who registered with `storage_deposit` mint up
to 1,000 tUSDC per call to themselves. It is a testnet faucet token with no value. Never
deploy it on mainnet; on mainnet the deed uses native USDC
(`17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`).

## Invariants

Checked by the integration tests after every flow and by the smoke run on testnet:

1. Vault: payment-token balance == `liabilities + revenue + in_flight`.
2. Deed: payment-token balance == claimable proceeds + proceeds in flight.
3. A seq is charged at most once per customer.
4. `liabilities` only leaves the vault through `claim_refund` to the customer it belongs to.
5. The vault account holds no key other than the current worker's function-call key.
6. The deed token owner and the vault owner match once the latest push has landed, and the
   vault epoch never decreases.

## Threat model

| Actor | Can | Cannot |
|---|---|---|
| Leaked worker key | Mis-charge customers within their balance and daily cap; burn its gas allowance (at most 5 NEAR, default 0.5). | Move money out (function-call keys cannot attach deposits and `charge` makes no transfers); call any other method; outlive a rotation. |
| Seller during a listing | Keep running the business; cancel the listing (then the lock goes away). | Withdraw, rotate the worker key, change config or price while listed; transfer the token; sell on an outside marketplace (no approvals). |
| Seller after the sale | Nothing on the vault. Their worker keeps charging (revenue goes to the buyer) until the buyer rotates. | Withdraw (`only the deed owner`), rotate, reconfigure. |
| Deed admin (`admin_id`) | Nothing: no admin methods exist. | Move tokens, withdraw, change or lock vaults. |
| Holder of the deed account's full-access key (testnet) | Redeploy the deed code, which could push fake owners to vaults. See "Admin powers". | Change vault code (vaults have no full-access key). |
| Customer | Deposit, set their own daily cap, request and claim a refund of their whole balance after the delay. | Withdraw revenue; charge; touch other customers' balances. |
| Outside caller | Push stats, re-sync a vault owner, fund gas, buy a listed deed at its price. | Call `set_owner`, `lock`, `unlock` (deed only), `on_stats` (that vault only), `charge`, owner methods, the vault `new`. |

Known limits:

- A failed owner push after a plain `nft_transfer` leaves the old owner in the vault until
  someone calls `sync_vault`. After a sale this is not exploitable because the vault stays
  locked until the newer epoch arrives.
- The image hash and endpoint are published claims by the owner. Nothing on chain proves
  which code the worker runs. TEE attestation is roadmap.
- Customers trust the worker to deliver what it charges for. Signed receipts (Phase B) make
  mis-charging visible; caps and refunds limit the damage.
- This is a self-review, not an independent audit.
