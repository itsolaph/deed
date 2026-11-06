# Demo

`bash scripts/demo-testnet.sh` runs the whole Outlive story on testnet. It takes 8 to 16 minutes depending on how fast the public RPC answers, prints an explorer link at every step, writes the links to `deployments/testnet.json` (section `demo`) and stops every process it started. Logs of every process go to `demo-logs/<run>/` (not committed).

Two more runs show the failure cases: a seller that does not cooperate ([Hostile seller](#hostile-seller)) and a seller that inflates revenue ([Wash revenue rejected](#wash-revenue-rejected)).

## Before you start

- Node 22 or newer, `npm ci` done (the script runs it if `node_modules` is missing).
- Four testnet accounts with keys in the near-cli legacy keychain (`~/.near-credentials/testnet/<account>.json`). By default the script uses the project's accounts from `deployments/testnet.json`; set `DEMO_SELLER`, `DEMO_BUYER`, `DEMO_ALICE` and `DEMO_BOB` to use your own. The seller needs about 3.5 NEAR (a mint costs 2.88 NEAR, most of it the vault's code storage), the others about 1 NEAR each.
- Free local ports 7601 (worker A), 7602 (worker B) and 7611 (echo target), all on 127.0.0.1.
- tUSDC is minted for the buyer and the customers as needed. It is a test token without value.

Optional: `DEMO_SLUG` (default `relay-<MMDDHHMM>`), `DEMO_TRAFFIC_SEC` (traffic before the listing, default 75), `DEMO_AFTER_SEC` (traffic after the handover, default 45), `DEMO_PORT_A`, `DEMO_PORT_B`, `DEMO_ECHO_PORT`, `NEAR_RPC_URLS`. All settings can also go in a git-ignored `.env` (see `.env.example`).

The buyer agent runs with `--policy demo`: at least 2 independent paying customers, none above 80% of independent revenue, no minimum vault age. It prints "demo policy: thresholds relaxed for a 10-minute run". With the default strict policy (3 customers, 60%, 72 hours) it would not buy a vault that is minutes old, which is the point of the strict policy.

## Steps and expected output

Excerpts below are from the recorded runs `relay-11060332` and `relay-11061238` (6 November 2026; the latter on the current protocol, whose hand-over carries only already-charged work), some lines shortened. Hashes and numbers differ in every run.

### 1. The seller mints the token

`owner mint` calls `mint` on the token with the mint cost attached. The contract creates `<slug>.<factory>.testnet` under the deployed factory (currently `outlive3.outlive.testnet`), deploys the vault code, initializes it, and only then mints the token. The vault account has no access key at all.

```
=== 1. seller mints the token; the Outlive contract creates the vault sub-account
ok   seller mints relay-11060332
vault relay-11060332.outlive2.outlive.testnet access keys after mint: 0 (no full-access key)
```

### 2. Worker A is registered

`owner rotate` generates a key pair (stored with mode 600 under `~/.near-credentials/testnet/workers/`) and sends `set_worker` and `set_config` in one transaction. The vault adds the key itself as a function-call key that may only call `charge`.

```
=== 2. seller registers worker A (function-call key limited to charge)
ok   seller sets worker key A and endpoint
```

### 3. Echo target and worker A start

The echo target answers 503 to about 30 percent of first attempts so retries show, and checks the relay signature on every request. Worker A starts with `--allow-target 127.0.0.1:7611` (the only non-public address it may call) and prints a warning about it.

```
=== 3. echo target and worker A start
worker A healthy: key ed25519:9zAZfCHaovVVxDyWz9AnkRXHCwfM59wPvsEyEUanNCL3, price 10000
```

`price 10000` is 0.01 tUSDC per delivery (6 decimals).

### 4. Traffic: alice and bob pay per delivery

The traffic agent sends a delivery every 2 seconds per customer through `OutliveClient`. The first call answers 402 (unknown customer); the SDK pays 5 tUSDC with `ft_transfer_call` to the vault and goes on. Worker A charges in batches; the vault revenue goes up.

```
=== 4. traffic: alice and bob send deliveries (first call answers 402, the SDK tops up)
ok   customer deposit after a 402 (ft_transfer_call)
ok   customer deposit after a 402 (ft_transfer_call)
ok   worker A charges a batch (4 items, signed by the worker key)
```

Deliveries the target drops on purpose are retried and counted once.

### 5. The NFT certificate updates

`push_stats` sends the vault figures to the token. `nft_token` now returns a certificate SVG and an `extra` JSON with the 30-day calls and revenue. Any marketplace or wallet that reads the token sees a service with traffic, not an empty shell.

```
=== 5. stats pushed to the token; the NFT certificate updates
ok   push_stats updates the dynamic NFT metadata
token stats now: 64 calls, revenue 0.6400 tUSDC
```

### 6. The seller withdraws and lists

The seller withdraws all revenue, then lists the token for 3 tUSDC. The listing becomes active only after the vault confirmed the lock: no withdraw, no price change, no endpoint change while it is for sale.

```
=== 6. seller withdraws revenue, then lists the token (the vault locks)
ok   seller lists relay-11060332 for 3 tUSDC
```

### 7. The buyer agent decides and buys

From the same run; six passing static checks left out:

```
[buyer] I am outlive-buyer.testnet. I look for tokens on outlive2.outlive.testnet whose payback on chain-visible costs is within 30 days.
[buyer] policy demo: at least 2 independent paying customers, none above 80% of independent revenue, vault at least 0 h old
[buyer] demo policy: thresholds relaxed for a 10-minute run
[buyer] --- relay-11060332 (Webhook Relay) listed by outlive-seller2.testnet for 3 tUSDC, listing #1
[buyer]   customer outlive-alice.testnet: 33 paid calls, 0.33 tUSDC -> counted: pays its own credit
[buyer]   customer outlive-bob.testnet: 33 paid calls, 0.33 tUSDC -> counted: pays its own credit
[buyer] independent revenue 0.66 tUSDC; not counted: owner 0 tUSDC, owner-funded 0 tUSDC, unverified 0 tUSDC, not in the event log 0 tUSDC
[buyer] per day: independent revenue 0.6600 - on-chain gas 0.1227 = net 0.5373 tUSDC (hosting, bandwidth and operator time not included)
[buyer] payback on chain-visible costs = (price 3 - cash 0.66) / net per day 0.5373 = 4.36 days
[buyer] check pass seller owns the token: token owner outlive-seller2.testnet, vault owner outlive-seller2.testnet
[buyer] check pass vault locked for this listing: locked=true lock_id=1 epoch=1
[buyer] check pass worker key registered: ed25519:9zAZfCHaovVVxDyWz9AnkRXHCwfM59wPvsEyEUanNCL3
[buyer] check pass endpoint answers: http://127.0.0.1:7621 serves this vault with the registered worker key
[buyer] decision: BUY (payback on chain-visible costs 4.4 days is under 30)
[buyer] funding from eth:usdc with NEAR Intents 1Click: mainnet dry quote (dry:true), nothing executed:
[buyer]   would pay 3.035282 USDC on eth (about 3.033727935616 USD) -> would receive 3.0 USDC on NEAR at 6d3bcc7f...
[buyer] token owner now outlive-buyer.testnet (epoch 2, locked false)
```

alice and bob are the project's own traffic agents. They pay their own credit with tUSDC they minted themselves, so the appraisal counts them as independent; that is exactly the limit stated in [DESIGN.md](DESIGN.md#buyer-agent).

The funding quote is a NEAR Intents 1Click mainnet dry quote (`"dry": true`), nothing executed: it shows what paying from Ethereum would cost, but no deposit address exists and nothing moves. The purchase itself uses tUSDC.

### 8. The seller's withdraw reverts

```
=== 8. the seller's withdraw now reverts
withdraw: FAILED ... Smart contract panicked: only the token owner
```

The seller still holds the account and the old worker key. Neither is enough any more.

### 9. Worker B and one rotation

The script opens a short outage at the echo target so worker A holds undelivered, paid deliveries. The buyer generates key B, starts worker B (it waits until the key is registered), then sends `set_worker` and `set_config` (new endpoint) in one transaction. Rotation deletes A's key and authorises B's in the same transaction.

```
ok   buyer rotates the worker key and endpoint in one transaction
worker B is serving
```

### 10. Worker A retires by itself

```
worker-a exited (code 0)
ok   worker A stops by itself after the rotation  (hand-off to http://127.0.0.1:7604: 18 of 40 obligations taken over)
ok   worker B holds every open obligation of worker A  (42 of 40 open obligations: hand-off 18/40 (settled only, 0 charged as new), 24 via customer presentations (24 charged as new); receipts presented by outlive-alice.testnet: 12 taken over (12 charged as new), 8 already here, 0 rejected; hand-off received from the previous worker: 16 taken over (0 charged as new), 2 already here, 22 rejected; receipts presented by outlive-bob.testnet: 12 taken over (12 charged as new), 8 already here, 0 rejected)
```

A polls the vault, sees a key it no longer owns, hands the work the chain already charged to the endpoint now on chain, and exits. The hand-off carries only settled work: an obligation A accepted but never charged is refused there, because a key that was removed — or anyone holding its secret — could forge receipts and proofs, and history proves a key once charged, not that it still may. Those obligations reach worker B through their customers instead: the SDK reads the new endpoint from the vault after a 410 (or a refused connection once A exited) and presents its open receipts with NEP-413, and B charges them once as new. Whichever path reaches B first takes the obligation over; the other finds it already there.

### 11. Traffic continues through worker B

The outage ends, worker B delivers what it took over, and new receipts are signed by key B. When the traffic agent stops it waits until every receipt it holds is confirmed delivered.

```
=== 11. traffic continues through worker B
vault revenue 1.4200 tUSDC (now the buyer's), 142 charges, endpoint http://127.0.0.1:7622
ok   every pending obligation was delivered  (outlive-alice: 40 accepted, 40 delivered, 0 failed; outlive-bob: 40 accepted, 40 delivered, 0 failed)
ok   receipts were signed by both workers  (2 worker keys)
```

### 12. The buyer withdraws

```
=== 12. buyer withdraws the revenue
vault revenue 1.46 tUSDC, owner on chain outlive-buyer.testnet, locked false; withdrawing 1.46
ok   buyer withdraws revenue
final: owner outlive-buyer.testnet (epoch 2), 146 calls, revenue 1.4600 tUSDC over the run
```

The buyer withdraws the revenue earned since the purchase and pushes the stats again.

## Recorded run (6 November 2026, `relay-11060332`, 18 of 18 steps)

Seller `outlive-seller2.testnet` (fresh faucet account), buyer `outlive-buyer.testnet`, customers `outlive-alice.testnet` and `outlive-bob.testnet`. All steps are in `deployments/testnet.json` under `demo`.

| # | Step | Result | Transaction |
| --- | --- | --- | --- |
| 1 | seller mints relay-11060332 | ok | [`7Xq3CbuP…`](https://testnet.nearblocks.io/txns/7Xq3CbuPXj2gXQ5x1kKzyQuNfENLiazb81XtGL8XZpCu) |
| 2 | seller sets worker key A and endpoint | ok | [`7UoENpUn…`](https://testnet.nearblocks.io/txns/7UoENpUn7BDZm6Yi57BPVU2QRFiiA1hqQByHkrcLjxyQ) |
| 3 | customer deposit after a 402 (ft_transfer_call) | ok | [`GnFZufQ9…`](https://testnet.nearblocks.io/txns/GnFZufQ9QMqCnZUEctLfBGcce1BWw3KK17CUmKrY1EuC) |
| 4 | customer deposit after a 402 (ft_transfer_call) | ok | [`2wmE6rMw…`](https://testnet.nearblocks.io/txns/2wmE6rMws4pkctSoG9ZRDx55WkZeetWN3BuQc1hwoptU) |
| 5 | worker A charges a batch (4 items, signed by the worker key) | ok | [`Fp7VNa4n…`](https://testnet.nearblocks.io/txns/Fp7VNa4nHeMTy6fTXs6bv58cA7BYh7En86DYxeEadxRP) |
| 6 | push_stats updates the dynamic NFT metadata | ok | [`39HP1E6J…`](https://testnet.nearblocks.io/txns/39HP1E6JmEWwxPBgU6CA48wxtuKaGN6AtKnGgapoNRMA) |
| 7 | seller withdraws revenue before listing | ok | [`49j6rfJC…`](https://testnet.nearblocks.io/txns/49j6rfJCqwHz4QvixHuWrV7gZr93pMT411uB3Kgz87d8) |
| 8 | seller lists relay-11060332 for 3 tUSDC | ok | [`BnDnbvp2…`](https://testnet.nearblocks.io/txns/BnDnbvp2PeB6koM3vpruotwwpvAABXtDr2qWvLKePw6n) |
| 9 | buyer agent buys relay-11060332 | ok | [`HeTSJDPe…`](https://testnet.nearblocks.io/txns/HeTSJDPesRMDm5KK8Br9T4RYheNdSjHbbpok8RNAKQDZ) |
| 10 | seller withdraw after the sale reverts (only the token owner) | ok | [`An746jXr…`](https://testnet.nearblocks.io/txns/An746jXrJscGBxarMQE2UKNSdWXqziprs5BoaAFFDTqN) |
| 11 | buyer rotates the worker key and endpoint in one transaction | ok | [`9J2SNdXc…`](https://testnet.nearblocks.io/txns/9J2SNdXcUJUN8oRanqFQTRNaJGjvRXsmnXMAtxVSGZYF) |
| 12 | worker A stops by itself after the rotation | ok |  |
| 13 | worker B holds every open obligation of worker A | ok |  |
| 14 | every pending obligation was delivered | ok |  |
| 15 | receipts were signed by both workers | ok |  |
| 16 | worker B charges with the new key (36 items) | ok | [`J1GDpy4m…`](https://testnet.nearblocks.io/txns/J1GDpy4muKuBqfAa1WKS6ANSfwN6QytyfwBsfimUrU8A) |
| 17 | buyer withdraws revenue | ok | [`FhRcKBsr…`](https://testnet.nearblocks.io/txns/FhRcKBsrYoSqdm35qPT3FcigMt92aERUPfbDi67ZwAbe) |
| 18 | push_stats after the sale | ok | [`8MemftHB…`](https://testnet.nearblocks.io/txns/8MemftHBk41E7egbcj1nJxUsNVQnqiWH8pSt69H12GjG) |

Off chain in the same run (protocol v2, `relay-11061238`): worker A saw the rotation, handed the 18 obligations the chain had already charged to worker B, refused nothing else, and exited by itself; the 22 obligations it had accepted but not yet charged were refused by the hand-off and recovered by their customers, who presented their saved receipts to B and were charged once for each; alice and bob each had 41 jobs accepted and delivered, none failed, receipts signed by both worker keys. The buyer agent's 1Click mainnet dry quote (nothing executed) for funding the 3 USDC from Ethereum came back at 3.035282 USDC.

### The same run, attacked

`scripts/theft-proof.mjs` replays the actions a stolen worker key would try on this vault. All six are blocked before execution or on chain; no funds move.

```
theft-proof check on relay-11060332.outlive2.outlive.testnet
The API server holds this key. What NEAR allows it to do:
   receiver relay-11060332.outlive2.outlive.testnet   methods ["charge"]   no deposits
▸ 1. Worker key calls withdraw
   BLOCKED by the protocol before execution: MethodNameMismatch
▸ 2. Worker key sends the vault's NEAR away
   BLOCKED by the protocol before execution: RequiresFullAccess
▸ 3. Worker key gives itself a full-access key
   BLOCKED by the protocol before execution: RequiresFullAccess
▸ 4. Worker key calls the token contract directly
   BLOCKED by the protocol before execution: ReceiverMismatch
▸ 5. A stranger calls withdraw:  BLOCKED on-chain: only the token owner
6/6 attempts blocked.  Withdrawable 0.00 tUSDC → 0.00 tUSDC, vault balance 8.54 tUSDC → 8.54 tUSDC
```

This is the tested actions only, not a proof that no other path exists. Re-checked on the live protocol v2 relay `relay-live.outlive3.outlive.testnet` (6 November 2026): all six unauthorized actions rejected again, including the old owner's worker key after the sale (`AccessKeyDoesNotExist`).

## What it shows

- The token carries the service instance: the buyer gets the withdrawable proceeds, the revenue from the next charge on and the customer ledger, and the seller's withdraw fails.
- The contract, not the seller, owns the vault's keys: after the sale the vault answers to the token owner.
- One key rotation moves the work to a new server; the old one stops by itself.
- Paid obligations survive a cooperative move: nothing is lost, nothing is charged twice, and the hand-off carries only work the chain already charged, so a removed key cannot keep billing through its successor.
- An agent can appraise and buy a token from on-chain data alone, here with the relaxed demo policy (printed by the agent). All traffic in this run comes from the project's own agents, alice and bob, so the payback figure describes that traffic, not demand.

What it does not show: demand from strangers, mainnet economics, or a market of many buyers. A seller that does not cooperate is covered below, and so is a seller that inflates revenue.

# Hostile seller

`bash scripts/hostile-seller.sh` (about 20 minutes, 10 of them the vault's refund delay). The seller sells the token and kills its worker with SIGKILL before any hand-off, while alice and bob have jobs in flight. Logs go to `demo-logs/<run>/`, links to `deployments/testnet.json` under `hostileSeller`. The analysis behind it is in [DESIGN.md](DESIGN.md#hostile-seller-the-old-worker-is-killed-not-handed-off).

1. The seller mints a token and runs worker A; alice and bob deposit 1.5 tUSDC each and send 3 jobs each, which are delivered and charged.
2. The seller lists the token for 2 tUSDC; the buyer buys it.
3. The target goes down. Each customer sends 3 more jobs; A charges them but cannot deliver them. Each sends 2 more; A accepts them. Then the seller kills A with SIGKILL: no flush, no hand-off. The script reads each customer's `last_seq` on chain and sorts the open receipts into charged-not-delivered and accepted-not-charged.
4. The buyer starts worker B and rotates key and endpoint in one transaction (A's key is deleted). The target comes back.
5. Alice's process "restarts": a new `OutliveClient` loads her receipts from its file store and `resubmit()`s them to the endpoint now on chain. B delivers the charged ones without a new charge and charges the uncharged ones once. Two new calls of alice are served by B.
6. Bob asks for his money back: `request_refund`, then he resubmits. B delivers the jobs A charged and refuses to charge the others while the refund is pending. After the refund delay bob claims his whole unspent credit.
7. Ledger check: each customer's number of charges on chain and the tUSDC it spent equal price x distinct jobs charged. Double charges must be 0.

Recorded run `hostile-11060310` (6 November 2026, seller `outlive-hostile.testnet`, buyer `outlive-buyer.testnet`, customers `outlive-alice.testnet` and `outlive-bob.testnet`, all the project's own accounts):

| | Result |
|---|---|
| Jobs in flight at the kill | 10: 6 charged on chain but not delivered, 4 accepted but not charged (3 + 2 per customer) |
| Delivered by worker B | 10 of the 10 (alice's 5 after her restart: 3 without a new charge, 2 charged once by B; bob's 3 charged ones without a new charge), plus 2 new calls served by B |
| Refunded | bob's 2 uncharged jobs were refused while his refund was pending; he got 1.44 tUSDC back (1.5 deposited minus 6 charged calls) |
| Double charges | 0: alice 10 charges on chain for 10 distinct jobs (0.10 tUSDC), bob 6 for 6 (0.06 tUSDC) |

```
worker-a exited (SIGKILL)
jobs in flight at the kill: 10 (charged on chain, not delivered: 6; accepted, not charged: 4)
ok   worker B takes over alice's receipts (3 already charged by A: no new charge; 2 never charged: charged once by B)
ok   bob claims his refund (unspent credit, including every job A never charged)  (1.44 tUSDC back)
alice: 10 charges on chain for 10 distinct jobs, spent 0.1 tUSDC.  bob: 6 charges for 6 distinct jobs
ok   double charges: 0  (0 double charges; spend matches price x distinct jobs: true)
```

| Step | Transaction |
|---|---|
| Seller mints `hostile-11060310` | [see record](https://testnet.nearblocks.io/address/hostile-11060310.outlive2.outlive.testnet) |
| Buyer buys the token | [AKbLaJ1M…](https://testnet.nearblocks.io/txns/AKbLaJ1MwikfTa9zsU9D6NkxdTyxLWpgbY3LFkbmbhYx) |
| Buyer rotates key and endpoint (A's key deleted) | [BXAg3YUT…](https://testnet.nearblocks.io/txns/BXAg3YUTXQAsLiYaWiZZxtBrTModihuJXW4WMUB6SLL6) |
| Bob requests a refund | [GBvXW8ft…](https://testnet.nearblocks.io/txns/GBvXW8ftYyo7bQHqsAcZECtQr9TMJBE44ZGjBb8hXdfr) |
| Bob claims 1.44 tUSDC after the refund delay | [9KawW61j…](https://testnet.nearblocks.io/txns/9KawW61jwDQLceAzgthecTfYjR8YeEAQrkhxdc9HdtvH) |

The refund delay is 600 seconds on this deployment; the run waits it out rather than shortening it for the camera.

# Wash revenue rejected

`node scripts/wash-reject.mjs` (about 4 minutes). The seller mints a token, creates two fresh accounts and funds them itself: the first gets 3 tUSDC by `ft_transfer`, the second gets its credit deposited by the seller (`deposit_for`). Both send 8 paid jobs, worker A charges all 16, the seller lists. The buyer agent runs with `--policy demo --dry-run` and skips. Links in `deployments/testnet.json` under `washReject`.

Recorded run `wash-11060325` (6 November 2026, seller `outlive-wash.testnet`):

```
=== Wash-revenue rejection on testnet: outlive outlive2.outlive.testnet, new business wash-11060325
ok   seller creates customer account wash-11060325-c1.testnet
ok   seller deposits credit for wash-11060325-c2.testnet (deposit_for, sender != customer)
[buyer]   customer wash-11060325-c1.testnet: 8 paid calls, 0.08 tUSDC -> NOT counted (owner-funded): funded by outlive-wash.testnet (signed a transaction touching the account)
[buyer]   customer wash-11060325-c2.testnet: 8 paid calls, 0.08 tUSDC -> NOT counted (owner-funded): credit deposited by outlive-wash.testnet (deposit_for)
[buyer] independent revenue 0 tUSDC; not counted: owner 0 tUSDC, owner-funded 0.16 tUSDC, unverified 0 tUSDC, not in the event log 0 tUSDC
[buyer] check FAIL independent paying customers: 0 independent of 2 paying customers, need 2; revenue from owner-funded customers excluded (...)
[buyer] check FAIL no single customer dominates: no independent revenue at all
[buyer] decision: SKIP (failed checks: independent paying customers (...); no single customer dominates (no independent revenue at all))
```

| Step | Transaction |
|---|---|
| Seller creates customer account `wash-11060325-c1.testnet` | [GjFQ6oY6…](https://testnet.nearblocks.io/txns/GjFQ6oY6pv2a8AcLwkbVeHhSmVpe8NffsSyBdoYxhGYm) |
| Seller creates customer account `wash-11060325-c2.testnet` | [2w5TXDce…](https://testnet.nearblocks.io/txns/2w5TXDCer3q3uSa8hnk6JX7aeua2jC7qjunSk9z2inWn) |
| Seller sends 3 tUSDC to c1 (`ft_transfer`) | [5qKQQVtX…](https://testnet.nearblocks.io/txns/5qKQQVtXtXvp668mWiaCY5nYKYLCUQ88pBvpSeiv5Wz2) |
| Seller deposits credit for c2 (`deposit_for`) | [F4DD3yVF…](https://testnet.nearblocks.io/txns/F4DD3yVFwHadxD77Xp9h39xzsUBiQmYUtfs65sfx4n4S) |
| Seller lists for 1 tUSDC | [6zhzgzn8…](https://testnet.nearblocks.io/txns/6zhzgzn8Q7Va6P4886Xa7vPe8RBbEKYtjM4m8kpvSGz1) |
| Seller cancels the listing after the agent's answer | [FbnMLgQX…](https://testnet.nearblocks.io/txns/FbnMLgQXchzkk2sAp4bfrgQVUQnbG65c4x6D8JuwgdXX) |

The vault itself reports 16 calls and 0.16 tUSDC of revenue; without the appraisal the old agent would have counted all of it. The trace is the point: the agent finds the funding transaction for the first customer and the `deposit_for` call for the second, and subtracts both. Faking demand costs the seller the same tUSDC as real demand, and still does not count.
