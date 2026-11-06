# Design

Outlive turns a running paid API into an NFT. One token is one transferable service instance: the
vault with its treasury, price list, customer ledger and worker key. Whoever holds the token
can withdraw its revenue and choose which server does the work. Selling the token moves that
instance to the buyer while customers keep calling it. Servers, domains and code stay off chain;
nothing here is a legal transfer of a business.

The demo business is a durable webhook relay. Customers (often agents) prepay credit and pay
per accepted delivery. The relay retries until the target answers, signs a receipt for every
accepted delivery and a proof for every attempt, and charges the vault in batches.

## Parts

```
             NEP-171 token "relay"                       one vault per business
  +---------------------------------+  set_owner(epoch)  +----------------------------------+
  | Outlive contract (outlive2...)        | ----------------> | vault  relay.outlive2...            |
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

- `contracts/outlive`: NEP-171/177/181 registry, vault factory, built-in sale, dynamic metadata.
  Details in [CONTRACTS.md](CONTRACTS.md).
- `contracts/vault`: one per business on `<slug>.<outlive>`. Treasury, price list, customer
  ledger, worker authorization.
- `worker/`: one process per business. HTTP gateway with NEP-413 auth and HTTP 402, durable
  webhook relay, batched charger, handover.
- `sdk/`: `OutliveClient` for customers, plus the shared signing and view code.
- `agents/`: flaky echo target, traffic generator, buyer agent, owner tools, 1Click mainnet dry
  quotes (`dry: true`, nothing executed).
- `web/`: static app that lists tokens with live numbers and signs actions in the user's wallet.

## What moves with the token, and what does not

Moves trustlessly, enforced by the contracts:

- **Treasury.** Withdrawable revenue in the vault. Only the current token holder can withdraw
  it. The contract pushes every ownership change to the vault with an increasing epoch.
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
is `outlive-relay-auth:v1`, the HTTP method, the path, the sha256 of the body and a timestamp, one
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
`{receipt_version: 2, request_sha256, delivery_id, vault, customer, seq, price,
 target_url_sha256, body_sha256, accepted_at, worker_public_key}`. `request_sha256` binds the
canonical normalized URL, HTTP method, header names and values, body and idempotency key. A
request reusing an idempotency key with different content receives HTTP 409, including while
the first admission is still waiting for RPC. Concurrent customer resubmission and worker
handoff of one obligation share one admission and one charge.

Legacy receipts without the complete request hash still have verifiable signatures, but the
SDK and takeover path reject them: their method, headers and idempotency key cannot be
authenticated. Do not upgrade a worker with open v1 obligations; drain them on the old worker
first. Existing locally journaled deliveries can still be replayed; that is not an upgrade of
customer-held v1 receipts.

Attempts follow `worker/src/retry.ts`: right away, then after 1 s, 5 s, 30 s, 2 min, 10 min,
then hourly, with 20 percent jitter, until 24 hours after acceptance. 2xx is delivered, 4xx
other than 408 and 429 fails for good, everything else is retried. Every attempt produces a
proof signed by the worker key: `{delivery_id, vault, attempt, status_code, response_sha256,
at, worker_public_key}`. `GET /v1/deliveries/:id` returns the state, the receipt and every
proof. Outbound requests carry `x-outlive-relay-*` headers with an ed25519 signature over the
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

The journal (`worker/src/journal.ts`) is append-only and synchronized to disk before each append
returns. Startup truncates an incomplete final record before appending again, preserves complete
records without a trailing newline, and refuses to start on corrupt complete records rather than
silently dropping accounting. On restart the worker replays it, continues pending deliveries and
sends unconfirmed charges again; the vault reports already applied sequence numbers as
`duplicate`, so an uncertain RPC response is retried with the original sequence, not a new bill.

### Charging

Each accepted delivery is one charge item (`units = 1`) at the vault price. The charger
(`worker/src/charger.ts`) batches up to 40 items every few seconds and signs `charge` as the
vault with the worker key. Sequence numbers per customer continue from the vault's `last_seq`.

Pre-accounting: for each customer the worker keeps the last chain view plus charges not yet
included by its `last_seq` (not sent, in flight, or confirmed but absent from a lagging RPC
view). Wall-clock ordering alone never proves inclusion. Confirmed charges reserve their actual
returned cost. A duplicate response with an unknown original debit blocks new admissions until
a ledger including that sequence is read. A scheduled cap decrease is planned for at once.

The current immutable vault charges at the on-chain price when the batch executes. The receipt's
`price` is an admission quote/reservation, not an enforceable price lock; a delayed batch crossing
a scheduled price change may debit a different amount. Drain pending work before price changes.
Exact accepted-price settlement needs a new contract API, not just an RPC timing check.
Temporary payment, cap, refund and retirement rejections during resubmission keep the customer's
saved obligation pending; they do not erase the receipt or request.

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
move with the token even if the old server is gone.

The SDK re-reads the endpoint from the vault after a 410 or a failed connection and presents
its pending receipts again before retrying.

### Hostile seller: the old worker is killed, not handed off

A seller can take the sale price and kill its worker (SIGKILL) before any hand-off: no flush of
pending charges, no `/v1/handoff`, and the journal stays on the seller's machine. What happens
to jobs in flight, checked against the code and by `scripts/hostile-seller.sh` on testnet:

| Job state at the kill | What happens | Customer pays |
|---|---|---|
| Charged on chain, delivered | Nothing to do. | once |
| Charged on chain, not delivered | The customer resubmits the receipt to the endpoint now on chain. Worker B sees its seq at or below the customer's `last_seq` when B first read it (after B became the registered worker), and delivers it without a charge. | once (by A) |
| Accepted by A, not charged | A's charge never went out. On resubmit B charges it once as new, with a fresh receipt, and delivers it. | once (by B) |
| Accepted by A, not charged, customer prefers its money back | The customer calls `request_refund`; B refuses to charge the receipt while the refund is pending; after the refund delay `claim_refund` returns the whole unspent credit, which still includes this job's price. | nothing |
| A late charge from A's key | Refused as a whole: the vault checks the signer key against the registered worker key, and the rotation deleted A's key. | nothing |

Why there is no double charge: A's charges can only execute before the rotation (they need A's
key as the registered worker key). B reads a customer's `last_seq` only after it saw itself as
the registered worker in a final block, so that mark includes every charge A ever made.

What the customer needs is the receipt and the request. `OutliveClient` keeps them in memory, and
with `store: fileStore(path)` (Node) also in a file, so a customer process that restarts can
`resubmit()` them; `adopt(entries)` takes receipts saved anywhere else. Receipts are checked
against the vault's worker key history (last 10 keys), so B accepts receipts signed by A's key.

Gaps, said plainly:

- A job that A charged and never delivered is made good by delivery, not by money: there is no
  on-chain clawback of a charged call. If the customer lost the receipt, nobody can deliver it
  (A's journal is gone) and the customer has paid for nothing. Caps and small balances limit
  this; an uptime bond is on the roadmap.
- The new owner has no service until it runs worker B and rotates; customers' calls in between
  fail to connect and nothing is accepted or charged.
- Delivery is at least once: a job A delivered but whose proof the customer never saw is
  delivered again by B (and charged once, by whoever charged it first).

## Buyer agent

`agents/src/buyer.ts` reads listings from the token and figures from the vault, then appraises
the revenue (`sdk/src/appraisal.ts`):

- per-customer paid revenue over the trailing 30 days, from the vault's own `vault_charge`
  events (each charged item names its customer), read through the FastNEAR transaction index;
- revenue charged to the current owner, every previous owner (ownership epochs from
  `vault_init`, `vault_owner` and `outlive_sold`), the listing seller, the vault and the token is
  excluded;
- customers funded by any of those accounts are excluded: a `vault_deposit` whose sender is
  one of them (`deposit_for`), a transaction signed by one of them that touches the customer
  account (account creation, NEAR or tUSDC transfers), a tUSDC `ft_transfer` from one of them,
  or a sub-account of one of them;
- customers whose funding history could not be read completely, and revenue the vault reports
  (`get_stats`) that no event in the window explains, are not counted either;
- credit paid in by a third party is counted under that sponsor, so one sponsor funding many
  accounts is one payer.

Payback is computed on independent revenue only and is called **payback on chain-visible
costs**: net per day = independent revenue per day minus on-chain gas per day (NEAR valued with
the 1Click token list price, or `--near-price`); hosting, bandwidth and operator time are not
included. Payback days = (listing price minus withdrawable proceeds) / net per day; the window
is the vault's age, at least 1 and at most 30 days.

It buys only if every check passes and payback is under `--max-payback-days`. Checks: listing
active and pinned, vault locked for that listing, no pending price increase, image hash set,
worker key registered, listing not stale, every ownership epoch read, endpoint answers with the
registered key, and the policy gates:

| Policy | Independent paying customers | Largest payer's share | Vault age |
|---|---|---|---|
| `strict` (default) | at least 3 | at most 60% | at least 72 h |
| `demo` | at least 2 | at most 80% | 0 h |

The demo policy exists so the 10-minute testnet demo can buy; the agent prints "demo policy:
thresholds relaxed for a 10-minute run" whenever it is used. `--min-customers`, `--max-share`
and `--min-age-hours` override single thresholds and are printed too. Every check is printed with
pass or fail and its reason. `scripts/wash-reject.mjs` shows the rejection path on testnet.

Funding is followed one hop: an owner who funds a fresh account through an intermediary is not
caught, and on testnet anyone can mint tUSDC, so a self-minting account with faucet NEAR looks
independent (the demo traffic agents are exactly that). The appraisal makes wash revenue cost
effort; it does not make it impossible.

With `--fund-from <chain:asset>` the agent asks NEAR Intents 1Click for a mainnet dry quote
(`"dry": true`, nothing executed) of funding the price from another chain and prints it. It
never deposits.

## Threat model (off-chain parts)

The contract threat model is in [CONTRACTS.md](CONTRACTS.md#threat-model). Off chain:

| Actor | Can | Cannot |
|---|---|---|
| Worker operator (the owner) | Accept and not deliver; charge customers within balance and cap (the receipt and missing proofs show it); see request bodies. | Charge more than a customer's balance or cap; charge one seq twice; move money out of the vault with the worker key. |
| A different customer | Send their own paid requests. | Act as another customer without that account's full-access key; replay a signed request (nonce and 5-minute window); read another customer's deliveries. |
| Someone with a stolen receipt | Present it to the worker again. | Get it charged twice (seq and delivery id are checked); change its target or body (hashes are signed). |
| A customer choosing targets | Point deliveries at any public URL. | Reach loopback, private, link-local or metadata addresses, directly, through DNS answers or through redirects. |
| Old worker after a sale | Keep serving until the buyer rotates; then only hand its queue over. Or be killed without a hand-off (see "Hostile seller"). | Charge after the rotation (its key is deleted, and the vault checks the signer key). |
| Seller inflating revenue before a sale | Pay its own vault from accounts it funds. | Get that revenue counted by the buyer agent when the funding is one hop away (see "Buyer agent"). |

Known limits of the worker:

- Deliveries a worker made but did not charge before its key was rotated go to the next worker
  with the hand-off and its proofs, and are charged once there. Without a hand-off (worker
  killed) they are charged once by the next worker only if the customer resubmits the receipt,
  and then delivered a second time.
- If a worker crashes without its journal, customers can still present their receipts, but
  attempts it made are lost from the status history.
- The worker trusts its RPC nodes for the chain view.
- The relay sends the customer's headers and body as given; secrets in them are visible to the
  worker operator.
