# Design

Deed turns a running paid API into an NFT. One token is one business. Whoever holds the token
owns the business: they can withdraw its revenue and choose which server does the work.
Selling the token moves the business to the buyer while customers keep calling it.

The demo business is a durable webhook relay. Customers (often agents) prepay credit and pay
per accepted delivery. The relay retries until the target answers, signs a receipt for every
accepted delivery and a proof for every attempt, and charges the vault in batches.

## Parts

```
             NEP-171 token "relay"                       one vault per business
  +---------------------------------+  set_owner(epoch)  +----------------------------------+
  | deed contract (deed2...)        | ----------------> | vault  relay.deed2...            |
  |  mint -> creates the vault      |  lock / unlock    |  treasury (payment token)        |
  |  built-in sale (list, buy)      |                   |  price, endpoint, image hash     |
  |  dynamic metadata (certificate) | <---------------- |  customer ledger (credit, caps)  |
  +---------------------------------+     on_stats      |  worker key (function-call key)  |
               ^                                        +----------------------------------+
               | ft_transfer_call {"buy":...}                ^ charge (signed as the vault
               |                                             |   with the worker key)
         buyer agent                                  +-------------+   signed deliveries
                                                      | worker      | ---------------------> targets
  customers --- NEP-413 signed requests ------------> | (gateway,   |
  (SDK)     <-- 402 / receipts / proofs / 410 ------- |  relay,     |
                                                      |  charger)   |
                                                      +-------------+
```

- `contracts/deed`: NEP-171/177/181 registry, vault factory, built-in sale, dynamic metadata.
  Details in [CONTRACTS.md](CONTRACTS.md).
- `contracts/vault`: one per business on `<slug>.<deed>`. Treasury, price list, customer
  ledger, worker authorization.
- `worker/`: one process per business. HTTP gateway with NEP-413 auth and HTTP 402, durable
  webhook relay, batched charger, handover.
- `sdk/`: `DeedClient` for customers, plus the shared signing and view code.
- `agents/`: flaky echo target, traffic generator, buyer agent, owner tools, 1Click dry quotes.
- `web/`: static app that lists deeds with live numbers and signs actions in the user's wallet.

## What moves with the token, and what does not

Moves trustlessly, enforced by the contracts:

- **Treasury.** Withdrawable revenue in the vault. Only the current token holder can withdraw
  it. The deed pushes every ownership change to the vault with an increasing epoch.
- **Price list.** The price per call. Increases need a 24-hour notice.
- **Customer ledger.** Balances, daily caps, sequence numbers, refund requests. Customer
  credit is never withdrawable by the owner.
- **Worker authorization.** The only key on the vault account is a function-call key limited
  to `charge`. The token holder rotates it with `set_worker`; the old key is deleted in the
  same step.

Does not move by itself:

- **The hosting.** The server, its domain and its uptime belong to whoever runs it. After a
  sale the seller's server keeps working until the buyer rotates the key (its charges already
  go to the buyer). After the rotation the old worker stops by itself and hands its queue over.
- **The image hash** in the vault is a published claim about the worker code. Nothing on chain
  enforces it. TEE attestation is on the roadmap.
- **Off-chain promises.** A worker can accept a paid delivery and never deliver it. Signed
  receipts and proofs make that visible; caps and refunds limit the damage.

## Worker

### Customer auth

Every customer request carries a NEP-413 signature (`sdk/src/nep413.ts`). The signed message
is `deed-relay-auth:v1`, the HTTP method, the path, the sha256 of the body and a timestamp, one
per line. The recipient is the vault account and the nonce is 32 random bytes. The worker
(`worker/src/auth.ts`) checks the signature, refuses timestamps more than 5 minutes off and
nonces it has seen, and asks RPC whether the public key is a full-access key of the claimed
account (cached for 60 seconds). NEP-413 asks for full-access keys; a function-call key that
some app holds should not be able to spend relay credit.

### Payment

Unknown customers, customers without enough balance or daily cap, and customers with a pending
refund get HTTP 402. The body names the vault, the token, the price per call, the minimum first
deposit and the exact `ft_transfer_call` (with a ready `near` CLI command). The SDK can top up
automatically and retry.

### Delivery engine

`POST /v1/deliveries` takes `{url, method, headers, body (max 64 KB), idempotency_key}` and
answers 202 with an obligation receipt signed by the worker key:
`{delivery_id, vault, customer, seq, price, target_url_sha256, body_sha256, accepted_at,
worker_public_key}`. The same idempotency key returns the same delivery and never a second
charge.

Attempts follow `worker/src/retry.ts`: right away, then after 1 s, 5 s, 30 s, 2 min, 10 min,
then hourly, with 20 percent jitter, until 24 hours after acceptance. 2xx is delivered, 4xx
other than 408 and 429 fails for good, everything else is retried. Every attempt produces a
proof signed by the worker key: `{delivery_id, vault, attempt, status_code, response_sha256,
at, worker_public_key}`. `GET /v1/deliveries/:id` returns the state, the receipt and every
proof. Outbound requests carry `x-deed-relay-*` headers with an ed25519 signature over the
vault, delivery id, attempt, timestamp, method, path and body hash, so a target can check that
the request came from a worker of that vault (`verifyOutbound` in the SDK).

Outbound requests are guarded against server-side request forgery (`worker/src/ssrf.ts`): only
http and https; DNS is resolved once and the connection goes to that pinned address; every
resolved address must be public (loopback, private, link-local and metadata, CGNAT, multicast,
unspecified, documentation and benchmark ranges are refused, including IPv6 forms such as
IPv4-mapped, IPv4-compatible, NAT64 and 6to4); every redirect hop is checked the same way (at
most 3); connect and response timeouts; responses are hashed up to 64 KB. Targets are checked
once before a delivery is accepted, so a blocked target never costs the customer anything. For
local demos one exact `ip:port` can be allowed with `--allow-target`; the worker logs a warning.

The only local state is an append-only journal (`worker/src/journal.ts`). On restart the
worker replays it, continues pending deliveries and sends unconfirmed charges again; the vault
reports already applied sequence numbers as `duplicate`, so nothing is charged twice.

### Charging

Each accepted delivery is one charge item (`units = 1`) at the vault price. The charger
(`worker/src/charger.ts`) batches up to 40 items every few seconds and signs `charge` as the
vault with the worker key. Sequence numbers per customer continue from the vault's `last_seq`.

Pre-accounting: for each customer the worker keeps the last chain view plus the charges the
view does not include yet (not sent, in flight, confirmed after the view was read). It accepts
a delivery only if the balance and the remaining daily cap, minus those charges, still cover
the price. A scheduled cap decrease is planned for at once. So the worker never promises more
than the vault will let it charge.

### Handover

The worker polls the vault every few seconds. When the worker key on chain is no longer its
own:

1. it stops accepting and answers every customer call with 410 and the new endpoint from chain;
2. it stops charging (its key is deleted on chain anyway);
3. it sends its pending deliveries to `<new endpoint>/v1/handoff`, signed with its old key;
4. it exits.

The new worker accepts obligations signed by any earlier worker key of the vault
(`get_worker_history`), from the old worker's hand-off or from customers re-presenting their
receipts (`POST /v1/obligations`). For each customer it records the vault's `last_seq` the first
time it sees them, after it became the registered worker. A receipt with a seq at or below that
mark was charged by an earlier worker: it is delivered without charging again. A higher seq was
never charged: the new worker charges it as new and issues a fresh receipt. Paid obligations
move with the deed even if the old server is gone.

The SDK re-reads the endpoint from the vault after a 410 or a failed connection and presents
its pending receipts again before retrying.

## Buyer agent

`agents/src/buyer.ts` reads listings from the deed and figures from the vault:

- trailing 30-day revenue and gas spent (`get_stats`), cash that comes with the vault
  (`revenue`), customer count, pending price, worker key, endpoint;
- the window is the vault's age, at least 1 and at most 30 days;
- net per day = revenue per day minus gas per day (NEAR valued with the 1Click token list
  price, or `--near-price`);
- payback days = (listing price minus cash) / net per day.

It buys only if every check passes (listing active and pinned, vault locked for that listing,
no pending price increase, image hash set, worker key registered, customers present, endpoint
answers with the registered key) and payback is under `--max-payback-days`. With
`--fund-from <chain:asset>` it asks NEAR Intents 1Click for a dry quote (`"dry": true`) of
funding the price from another chain and prints it. It never deposits.

For a vault that is minutes old the 1-day minimum makes the estimate optimistic; the agent
says so in its output. A real buyer should demand weeks of history.

## Threat model (off-chain parts)

The contract threat model is in [CONTRACTS.md](CONTRACTS.md#threat-model). Off chain:

| Actor | Can | Cannot |
|---|---|---|
| Worker operator (the owner) | Accept and not deliver; charge customers within balance and cap (the receipt and missing proofs show it); see request bodies. | Charge more than a customer's balance or cap; charge one seq twice; move money out of the vault with the worker key. |
| A different customer | Send their own paid requests. | Act as another customer without that account's full-access key; replay a signed request (nonce and 5-minute window); read another customer's deliveries. |
| Someone with a stolen receipt | Present it to the worker again. | Get it charged twice (seq and delivery id are checked); change its target or body (hashes are signed). |
| A customer choosing targets | Point deliveries at any public URL. | Reach loopback, private, link-local or metadata addresses, directly, through DNS answers or through redirects. |
| Old worker after a sale | Keep serving until the buyer rotates; then only hand its queue over. | Charge after the rotation (its key is deleted, and the vault checks the signer key). |

Known limits of the worker:

- Deliveries a worker made but did not charge before its key was rotated are not charged by
  anyone. The charge batch interval (4 seconds) keeps this small.
- If a worker crashes without its journal, customers can still present their receipts, but
  attempts it made are lost from the status history.
- The worker trusts its RPC nodes for the chain view.
- The relay sends the customer's headers and body as given; secrets in them are visible to the
  worker operator.
