# Demo

`bash scripts/demo-testnet.sh` runs the whole Outlive story on testnet. It takes 8 to 16
minutes depending on how fast the public RPC answers (16 in the recorded run), prints an explorer link at every step, writes the links to
`deployments/testnet.json` (section `demo`) and stops every process it started. Logs of every
process go to `demo-logs/<run>/` (not committed).

## Before you start

- Node 22 or newer, `npm ci` done (the script runs it if `node_modules` is missing).
- Four testnet accounts with keys in the near-cli legacy keychain
  (`~/.near-credentials/testnet/<account>.json`). By default the script uses the project's
  accounts from `deployments/testnet.json`; set `DEMO_SELLER`, `DEMO_BUYER`, `DEMO_ALICE` and
  `DEMO_BOB` to use your own. The seller needs about 3.5 NEAR (a mint costs 2.88 NEAR, most of
  it the vault's code storage), the others about 1 NEAR each.
- Free local ports 7601 (worker A), 7602 (worker B) and 7611 (echo target), all on 127.0.0.1.
- tUSDC is minted for the buyer and the customers as needed. It is a test token without value.

Optional: `DEMO_SLUG` (default `relay-<MMDDHHMM>`), `DEMO_TRAFFIC_SEC` (traffic before the
listing, default 75), `DEMO_AFTER_SEC` (traffic after the handover, default 45),
`DEMO_PORT_A`, `DEMO_PORT_B`, `DEMO_ECHO_PORT`, `NEAR_RPC_URLS`. All settings can also go in a
git-ignored `.env` (see `.env.example`).

The buyer agent runs with `--policy demo`: at least 2 independent paying customers, none above
80% of independent revenue, no minimum vault age. It prints "demo policy: thresholds relaxed for
a 10-minute run". With the default strict policy (3 customers, 60%, 72 hours) it would not buy a
vault that is minutes old, which is the point of the strict policy.

## Steps and expected output

Excerpts below are from earlier recorded runs (relay-10300721, and relay-1103hard for step 7), some lines shortened. Hashes and numbers differ in every run.

### 1. The seller mints the token

`owner mint` calls `mint` on the token with the mint cost attached. The outlive creates
`<slug>.outlive.testnet`, deploys the vault code, initializes it, and only then mints the
token. The vault account has no access key at all.

```
[owner outlivelab-seller.testnet] mint relay-... (deposit 2.879 NEAR, excess refunded): ok https://testnet.nearblocks.io/txns/...
[demo] vault relay-....outlive.testnet access keys after mint: 0 (no full-access key)
```

### 2. Worker A is registered

`owner rotate` generates a key pair (stored with mode 600 under
`~/.near-credentials/testnet/workers/`) and sends `set_worker` and `set_config` in one
transaction. The vault adds the key itself as a function-call key that may only call `charge`.

### 3. Echo target and worker A start

The echo target answers 503 to about 30 percent of first attempts so retries show, and checks
the relay signature on every request. Worker A starts with `--allow-target 127.0.0.1:7611`
(the only non-public address it may call) and prints a warning about it.

```
[worker 7601] worker key registered on chain; allowance left 2 NEAR
[worker 7601] listening on http://127.0.0.1:7601
[echo] d_3f... attempt 1 relay-sig ok key 3cjYRKtK.. -> 503 (on purpose)
[echo] d_3f... attempt 2 relay-sig ok key 3cjYRKtK.. -> 200
```

### 4. Traffic: alice and bob pay per delivery

The traffic agent sends a delivery every 2 seconds per customer through `OutliveClient`. The first
call answers 402 (unknown customer); the SDK pays 5 tUSDC with `ft_transfer_call` to the vault
and goes on. Worker A charges in batches every 4 seconds; the vault revenue goes up.

```
[traffic] alice  #1 402 unknown_customer (price 10000, min deposit 1000000)
[traffic] alice  topped up 5 tUSDC with ft_transfer_call: ok https://testnet.nearblocks.io/txns/...
[traffic] alice  #2 202 seq 1 receipt signed by worker 3cjYRK..
[worker 7601] charge tx ...: 4 of 4 items charged
[demo] revenue ticking: vault revenue 0.3600 tUSDC, customer credit 9.6400, 2 customers, 36 charges
```

### 5. The NFT certificate updates

`push_stats` sends the vault figures to the outlive. `nft_token` now returns a certificate SVG and
an `extra` JSON with the 30-day calls and revenue.

### 6. The seller withdraws and lists

The seller withdraws all revenue, then lists the token for 3 tUSDC. The listing becomes active
only after the vault confirmed the lock.

### 7. The buyer agent decides and buys

From the run `relay-1103hard` (3 November 2026); six passing static checks left out:

```
[buyer] policy demo: at least 2 independent paying customers, none above 80% of independent revenue, vault at least 0 h old
[buyer] demo policy: thresholds relaxed for a 10-minute run
[buyer] payback on chain-visible costs: net per day = revenue minus on-chain gas; hosting, bandwidth and operator time are not included.
[buyer] --- relay-1103hard (Webhook Relay) listed by outlivel12-seller.testnet for 3 tUSDC, listing #1
[buyer] vault relay-1103hard.outlive.testnet: withdrawable proceeds (cash) 0.69 tUSDC come with the token; customer credit 9.31 tUSDC is owed to 2 customers and is not withdrawable
[buyer] trailing 30 days per the vault: 69 calls, revenue 0.69 tUSDC, gas 0.0338 NEAR
[buyer] event log: 16 vault transactions in the index, 16 read (2 requests to tx.test.fastnear.com)
[buyer]   customer outlivelab-alice.testnet: 37 paid calls, 0.37 tUSDC -> counted: pays its own credit
[buyer]   customer outlivelab-bob.testnet: 32 paid calls, 0.32 tUSDC -> counted: pays its own credit
[buyer] independent revenue 0.69 tUSDC; not counted: owner 0 tUSDC, owner-funded 0 tUSDC, unverified 0 tUSDC, not in the event log 0 tUSDC
[buyer] the vault is 8 minutes old, so I spread the figures over 1.00 day(s) (at least 1, at most 30)
[buyer] per day: independent revenue 0.6900 - on-chain gas 0.1298 = net 0.5602 tUSDC (hosting, bandwidth and operator time not included)
[buyer] payback on chain-visible costs = (price 3 - cash 0.69) / net per day 0.5602 = 4.12 days
[buyer] check pass vault locked for this listing: locked=true lock_id=1 epoch=1
[buyer] check pass every owner known: 1 ownership epoch(s) read from the event log; excluded: outlive.testnet, outlivel12-seller.testnet, relay-1103hard.outlive.testnet
[buyer] check pass independent paying customers: 2 independent of 2 paying customers, need 2
[buyer] check pass no single customer dominates: largest payer outlivelab-alice.testnet has 54% of independent revenue, limit 80%
[buyer] check pass vault observed long enough: vault is 0.1 h old, need 0 h
[buyer] check pass endpoint answers: http://127.0.0.1:7603 serves this vault with the registered worker key
[buyer] decision: BUY (payback on chain-visible costs 4.1 days is under 30)
[buyer] funding from eth:usdc with NEAR Intents 1Click: mainnet dry quote (dry:true), nothing executed:
[buyer]   would pay 3.035391 USDC on eth (about 3.033336040293 USD) -> would receive 3.0 USDC on NEAR at 2e365a12...
[buyer]   estimated time 45 s. No deposit address exists for a dry quote; nothing was sent or swapped.
[buyer] buying: ft_transfer_call 3 tUSDC to outlive.testnet with msg {"buy":{"token_id":"relay-1103hard","max_price":"3000000","listing_id":1}}
[buyer] bought: https://testnet.nearblocks.io/txns/v2ty1Yv86qX62FbsTqLaU8yXTa88e4SuVBjgghNBXED
[buyer] outlive owner now outlivelab-buyer.testnet, vault owner now outlivelab-buyer.testnet (epoch 2, locked false)
```

alice and bob are the project's own traffic agents. They pay their own credit with tUSDC they
minted themselves, so the appraisal counts them as independent; that is exactly the limit
stated in [DESIGN.md](DESIGN.md#buyer-agent).

The funding quote is a NEAR Intents 1Click mainnet dry quote (`"dry": true`), nothing executed:
it shows what paying from Ethereum would cost, but no deposit address exists and nothing moves.
The purchase itself uses tUSDC.

### 8. The seller's withdraw reverts

```
[owner outlivelab-seller.testnet] withdraw: FAILED https://testnet.nearblocks.io/txns/... (... "Smart contract panicked: only the token owner")
```

### 9. Worker B and one rotation

The script opens a short outage at the echo target so worker A holds undelivered, paid
deliveries. The buyer generates key B, starts worker B (it waits until the key is registered),
then sends `set_worker` and `set_config` (new endpoint) in one transaction.

### 10. Worker A retires by itself

```
[worker 7601] HANDOVER: vault worker key is now ed25519:GWvGGo...; endpoint http://127.0.0.1:7602. This worker stops accepting and charging.
[worker 7601] 8 charges were not sent before the handover; they go to the next worker with the hand-off
[worker 7601] hand-off attempt 1 failed: fetch failed
[worker 7601] hand-off to http://127.0.0.1:7602: 21 of 21 obligations taken over
[worker 7602] hand-off received from the previous worker: 21 taken over (4 charged as new), 0 already here, 0 rejected
[worker 7601] exiting after handover
```

Receipts whose seq was already charged on chain (worker B compares with each customer's
`last_seq` when it first sees them) are delivered without a new charge; the rest are charged
by B with fresh receipts. In this run 8 charges were still open at A, 4 of them had in fact
landed in A's last charge transaction, so B charged only the other 4. Customers that call
worker A now get 410 with the new endpoint (or a refused connection once it exited); the SDK
reads the endpoint from the vault again and presents its open receipts. Whichever reaches B
first takes the obligation over; the other finds it already there.

### 11. Traffic continues through worker B

The outage ends, worker B delivers what it took over, and new receipts are signed by key B.
When the traffic agent stops it waits until every receipt it holds is confirmed delivered.

```
[traffic] summary alice: 70 accepted, 60 delivered, 10 pending, 1 x 402, workers {"3cjYRK":70}          (during the outage)
[traffic] summary alice: 78 accepted, 76 delivered, 2 pending, 1 x 402, workers {"3cjYRK":70,"GWvGGo":8}
[traffic] summary alice: 96 accepted, 96 delivered, 0 pending, 1 x 402, workers {"3cjYRK":70,"GWvGGo":26}
```

### 12. The buyer withdraws

The buyer withdraws the revenue earned since the purchase and pushes the stats again.

## Recorded run (3 November 2026, `relay-1103hard`, 18 of 18 steps)

Seller `outlivel12-seller.testnet` (fresh faucet account), buyer `outlivelab-buyer.testnet`, customers
`outlivelab-alice` and `outlivelab-bob`. All steps are in `deployments/testnet.json` under `demo`.

| Step | Transaction |
|---|---|
| Seller mints the token; the token creates the vault sub-account (no access key) | [34S7Fe…](https://testnet.nearblocks.io/txns/34S7FeZ1fc1bQv4dHUmCY11f6ubhctRr9hzKr3Q6sf5r) |
| Seller registers worker key A and the endpoint in one transaction | [6YsReh…](https://testnet.nearblocks.io/txns/6YsRehEyXA2hiYSm5Jcjb4gqmAp4axMnFooajGVxSEc7) |
| Customers get 402 and pay credit with `ft_transfer_call` | [RMa2kE…](https://testnet.nearblocks.io/txns/RMa2kEVrWy9N3vt1AzhgMVX9S6tWUPWV8Wyv3yY9Zov), [B6MGDS…](https://testnet.nearblocks.io/txns/B6MGDS6cknmqaETV5jjNi5kabayk9MX7MgDbcTrSrkGw) |
| Worker A charges a batch, signed as the vault with its function-call key | [9xBRsX…](https://testnet.nearblocks.io/txns/9xBRsXfny8CapwFSrmSjwiBgN1R1E9xgB1KatYpdwy3p) |
| Stats pushed; the NFT certificate updates | [6Xu6C6…](https://testnet.nearblocks.io/txns/6Xu6C67VjG4XaeRdgPDe58FSAcGcnt5SJfCQb4fnjzSK) |
| Seller withdraws revenue | [EgXTNe…](https://testnet.nearblocks.io/txns/EgXTNek5UuNnarCrVyA73R8qJDmbHj4ErdwCp12ehgHQ) |
| Seller lists for 3 tUSDC (the vault locks) | [7gsv5E…](https://testnet.nearblocks.io/txns/7gsv5EojrbKYKGs4MQAxD51mxbAL57LawFLhgvf46m9c) |
| Buyer agent (demo policy) appraises 0.69 tUSDC of independent revenue, payback on chain-visible costs 4.12 days, buys | [v2ty1Y…](https://testnet.nearblocks.io/txns/v2ty1Yv86qX62FbsTqLaU8yXTa88e4SuVBjgghNBXED) |
| Seller's withdraw after the sale reverts (`only the token owner`) | [39fQiK…](https://testnet.nearblocks.io/txns/39fQiK98qxZL6kPH9mwn8miyXXVCoiSiJnQ2Vcn2nvnD) |
| Buyer rotates worker key and endpoint in one transaction | [Ai6eou…](https://testnet.nearblocks.io/txns/Ai6eou54iAhaA2tf3kdp89EowKMf7TVNdUQecgj4ubzn) |
| Worker B charges with the new key | [JD99Ne…](https://testnet.nearblocks.io/txns/JD99NeTceMUQ7EF33oARm8Da2UrGkqrqwcNiMFvJ1nLx) |
| Buyer withdraws revenue | [AgUyC6…](https://testnet.nearblocks.io/txns/AgUyC6uQydhYgoUN1GcyWwX3QJGPNjPbJfisUSoQS34F) |
| Stats pushed after the sale | [6TJjtT…](https://testnet.nearblocks.io/txns/6TJjtTaT5oBDDAvCHYQvDdnVT9mZWaBUiKD4xdrSe5aY) |

Off chain in the same run: worker A saw the rotation, handed 25 open obligations to worker B and
exited by itself; customers presenting their receipts after the 410 reached B first for most of
them (B charged 10 as new in total, the rest had been charged by A). Alice had 34 jobs accepted
and delivered, bob 35, none failed, receipts signed by both worker keys. The buyer agent's 1Click
mainnet dry quote (nothing executed) for funding the 3 USDC from Ethereum came back at 3.035391
USDC.

## What it shows

- The token carries the service instance: the buyer gets the withdrawable proceeds, the revenue
  from the next charge on and the customer ledger, and the seller's withdraw fails.
- One key rotation moves the work to a new server; the old one stops by itself.
- Paid obligations survive a cooperative move: nothing is lost, nothing is charged twice.
- An agent can appraise and buy a token from on-chain data alone, here with the relaxed demo
  policy (printed by the agent). All traffic in this run comes from the project's own agents,
  alice and bob, so the payback figure describes that traffic, not demand.

What it does not show: a seller that does not cooperate (see "Hostile seller" below) and a
seller that inflates revenue (see "Wash revenue rejected" below).

# Hostile seller

`bash scripts/hostile-seller.sh` (about 20 minutes, 10 of them the vault's refund delay). The
seller sells the token and kills its worker with SIGKILL before any hand-off, while alice and bob
have jobs in flight. Logs go to `demo-logs/<run>/`, links to `deployments/testnet.json` under
`hostileSeller`. The analysis behind it is in
[DESIGN.md](DESIGN.md#hostile-seller-the-old-worker-is-killed-not-handed-off).

1. The seller mints a token and runs worker A; alice and bob deposit 1.5 tUSDC each and send 3
   jobs each, which are delivered and charged.
2. The seller lists the token for 2 tUSDC; the buyer buys it.
3. The target goes down. Each customer sends 3 more jobs; A charges them but cannot deliver
   them. Each sends 2 more; A accepts them. Then the seller kills A with SIGKILL: no flush, no
   hand-off. The script reads each customer's `last_seq` on chain and sorts the open receipts
   into charged-not-delivered and accepted-not-charged.
4. The buyer starts worker B and rotates key and endpoint in one transaction (A's key is
   deleted). The target comes back.
5. Alice's process "restarts": a new `OutliveClient` loads her receipts from its file store and
   `resubmit()`s them to the endpoint now on chain. B delivers the charged ones without a new
   charge and charges the uncharged ones once. Two new calls of alice are served by B.
6. Bob asks for his money back: `request_refund`, then he resubmits. B delivers the jobs A
   charged and refuses to charge the others while the refund is pending. After the refund delay
   bob claims his whole unspent credit.
7. Ledger check: each customer's number of charges on chain and the tUSDC it spent equal price x
   distinct jobs charged. Double charges must be 0.

Recorded run `hostile-1103c` (3 November 2026, seller `outlivel15-seller.testnet`, buyer
`outlivelab-buyer.testnet`, customers `outlivelab-alice` and `outlivelab-bob`, all the project's own
accounts):

| | Result |
|---|---|
| Jobs in flight at the kill | 10: 6 charged on chain but not delivered, 4 accepted but not charged (3 + 2 per customer) |
| Delivered by worker B | 8 of the 10 (alice's 5 after her restart: 3 without a new charge, 2 charged once by B; bob's 3 charged ones without a new charge), plus 2 new calls of alice |
| Refunded | bob's 2 uncharged jobs were refused while his refund was pending; he got 1.44 tUSDC back (1.5 deposited minus 6 charged calls) |
| Double charges | 0: alice 10 charges on chain for 10 distinct jobs (0.10 tUSDC), bob 6 for 6 (0.06 tUSDC) |

| Step | Transaction |
|---|---|
| Seller mints `hostile-1103c` | [Bmcnzq…](https://testnet.nearblocks.io/txns/Bmcnzq2c7VK1t4izhQs5y4P3icBDUCF9yHMJe6BtHZCS) |
| Seller registers worker A | [7NgGkS…](https://testnet.nearblocks.io/txns/7NgGkSZsDd4ju49cxymstoAZqZxjthE5Zm9eU358qefD) |
| Alice deposits 1.5 tUSDC | [HTvniA…](https://testnet.nearblocks.io/txns/HTvniAxBheCC8pc9qZ1cGiozEQZh6csVA763FcxcwbV6) |
| Bob deposits 1.5 tUSDC | [Dg66Xm…](https://testnet.nearblocks.io/txns/Dg66XmY5yy6XjMbun8FsnmTjHav6KjZUHVJxKWV4rMQH) |
| Seller lists for 2 tUSDC | [6PkN67…](https://testnet.nearblocks.io/txns/6PkN67HwBebUNpqFhZ33VsqX63yUBWjND3KprSkYmD8M) |
| Buyer buys | [mHAh5Q…](https://testnet.nearblocks.io/txns/mHAh5Qq6NGh8C8xAK3yeEKGACpnyGQq1ynFWD9PPiZN) |
| Worker A charges jobs it could not deliver (then SIGKILL) | [258RKq…](https://testnet.nearblocks.io/txns/258RKqqggkxNrcYzTNG4hasKMsM2ErRs7s6WA9ktQjun) |
| Buyer rotates key and endpoint (A's key deleted) | [xeMWP3…](https://testnet.nearblocks.io/txns/xeMWP37Q7UAFT9YtuKkoWp9AC7uZQrbzEa4wtz2tAYy) |
| Worker B charges with the new key (alice's 2 uncharged and her 2 new calls) | [F7nDmo…](https://testnet.nearblocks.io/txns/F7nDmoKJQx5D4Lc14GR1yrr6LLbCFJeAm4xAmNRqMKfx) |
| Bob requests a refund | [2bePEp…](https://testnet.nearblocks.io/txns/2bePEps9BjogecpvWHpWrhRoo2n3E5MHJHdAFUBs92fZ) |
| Bob claims 1.44 tUSDC after the refund delay | [3kF65x…](https://testnet.nearblocks.io/txns/3kF65xRXtGC4gz7CCxbBU2ff8MQK3XsU75BahytmPD1H) |

Two earlier attempts are recorded as failed in `hostileSeller_runs`. `hostile-1103a`: the
script assumed which jobs A would have charged by the kill; A's flush timer charged two of the
"uncharged" ones first. Every job was still charged once (alice 10 for 10, bob 7 for 7), but the
script's fixed expectations miscounted, so it now classifies receipts against the chain at the
kill. `hostile-1103b`: presenting receipts to the fresh worker B took longer than the SDK's
15-second request timeout (B was waiting on chain reads); the SDK now allows 90 seconds for
that request, as the worker's own hand-off does.

# Wash revenue rejected

`node scripts/wash-reject.mjs` (about 4 minutes). The seller mints a token, creates two fresh
accounts and funds them itself: the first gets 3 tUSDC by `ft_transfer` and deposits 2 as its
own credit, the second gets 2 tUSDC of credit deposited by the seller (`deposit_for`). Both send
8 paid jobs, worker A charges all 16, the seller lists. The buyer agent runs with
`--policy demo --dry-run` and skips. Links in `deployments/testnet.json` under `washReject`.

Recorded run `wash-1103a` (3 November 2026, seller `outlivel10-seller.testnet`):

| Step | Transaction |
|---|---|
| Seller mints `wash-1103a` | [2V1bJT…](https://testnet.nearblocks.io/txns/2V1bJTjJxb1Sy7LZKxqanrx3aVsTrZ2XktFA24maeAB7) |
| Seller creates customer account `wash-1103a-c1.testnet` | [5rLgd5…](https://testnet.nearblocks.io/txns/5rLgd5wPjni4qi4iSks8VhXJgK3e1sMdhipUDN6pmVKb) |
| Seller creates customer account `wash-1103a-c2.testnet` | [9qWmCX…](https://testnet.nearblocks.io/txns/9qWmCXCXLtLTkwcHddpusY3MozWMUtWaSR3aKBgfn3xE) |
| Seller sends 3 tUSDC to c1 (`ft_transfer`) | [HydByr…](https://testnet.nearblocks.io/txns/HydByarnc17gtbt9AXaTzscWrcVCx9cRrVaEXvqR1bF4) |
| c1 deposits it as its own credit (sender == customer) | [Cy5eL7…](https://testnet.nearblocks.io/txns/Cy5eL7CbxuZQVYv74DrxtVkkXcRnm2zC1w6GSX7DiPRi) |
| Seller deposits credit for c2 (`deposit_for`) | [JEEQsG…](https://testnet.nearblocks.io/txns/JEEQsGsSnSGWrAdeMf3N8H6u6VtencgVseYesDARzqgE) |
| Worker A charges the 16 jobs | [CiU2uo…](https://testnet.nearblocks.io/txns/CiU2uooHCz9xZPun7ECGLSx5fNBGeYTe1o4sABfkSJRV) |
| Seller lists for 1 tUSDC | [8AAV2N…](https://testnet.nearblocks.io/txns/8AAV2NZdo8YGJ8MscADZ1WVrKNrgamUWYHgRzvKfN6Rx) |
| Seller cancels the listing after the agent's answer | [5Rmjf5…](https://testnet.nearblocks.io/txns/5Rmjf597VFjuNtnS2PhvaDcBxtC5gQP6tq8U4za2LKG8) |

The agent's output (shortened):

```
[buyer] policy demo: at least 2 independent paying customers, none above 80% of independent revenue, vault at least 0 h old
[buyer] demo policy: thresholds relaxed for a 10-minute run
[buyer]   customer wash-1103a-c1.testnet: 8 paid calls, 0.08 tUSDC -> NOT counted (owner-funded): funded by outlivel10-seller.testnet (signed a transaction touching the account, tx 5rLgd5...)
[buyer]   customer wash-1103a-c2.testnet: 8 paid calls, 0.08 tUSDC -> NOT counted (owner-funded): credit deposited by outlivel10-seller.testnet (deposit_for)
[buyer] independent revenue 0 tUSDC; not counted: owner 0 tUSDC, owner-funded 0.16 tUSDC, unverified 0 tUSDC, not in the event log 0 tUSDC
[buyer] check FAIL independent paying customers: 0 independent of 2 paying customers, need 2; revenue from owner-funded customers excluded (...)
[buyer] check FAIL no single customer dominates: no independent revenue at all
[buyer] check pass endpoint answers: http://127.0.0.1:7605 serves this vault with the registered worker key
[buyer] decision: SKIP (failed checks: independent paying customers (0 independent of 2 paying customers, need 2; revenue from owner-funded customers excluded ...
```

The vault itself reports 16 calls and 0.16 tUSDC of revenue; without the appraisal the old
agent would have counted all of it.
