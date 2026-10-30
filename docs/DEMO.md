# Demo

`bash scripts/demo-testnet.sh` runs the whole Deed story on testnet. It takes about
6 minutes, prints an explorer link at every step, writes the links to
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
listing, default 75), `DEMO_AFTER_SEC` (traffic after the handover, default 45).

## Steps and expected output

Excerpts below are from the recorded run (relay-10300721), some lines shortened. Hashes and numbers differ in every run.

### 1. The seller mints the deed

`owner mint` calls `mint` on the deed with the mint cost attached. The deed creates
`<slug>.deed2.deedlab.testnet`, deploys the vault code, initializes it, and only then mints the
token. The vault account has no access key at all.

```
[owner deedlab-seller.testnet] mint relay-... (deposit 2.879 NEAR, excess refunded): ok https://testnet.nearblocks.io/txns/...
[demo] vault relay-....deed2.deedlab.testnet access keys after mint: 0 (no full-access key)
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

The traffic agent sends a delivery every 2 seconds per customer through `DeedClient`. The first
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

`push_stats` sends the vault figures to the deed. `nft_token` now returns a certificate SVG and
an `extra` JSON with the 30-day calls and revenue.

### 6. The seller withdraws and lists

The seller withdraws all revenue, then lists the deed for 3 tUSDC. The listing becomes active
only after the vault confirmed the lock.

### 7. The buyer agent decides and buys

```
[buyer] --- relay-... (Webhook Relay) listed by deedlab-seller.testnet for 3 tUSDC, listing #1
[buyer] vault relay-10300721.deed2.deedlab.testnet: cash 0.32 tUSDC comes with the deed; customer credit 9 tUSDC stays owed to 2 customers
[buyer] trailing 30 days: 100 calls, revenue 1 tUSDC, gas 0.03815 NEAR (about 0.1637 USD)
[buyer] the vault is 2 minutes old, so I spread the figures over 1.00 day(s) (at least 1, at most 30)
[buyer] per day: revenue 1.0000 - gas 0.1637 = net 0.8363 tUSDC
[buyer] payback = (price 3 - cash 0.32) / net per day 0.8363 = 3.20 days
[buyer] check ok   vault locked for this listing: locked=true lock_id=1 epoch=1
[buyer] check ok   endpoint answers: http://127.0.0.1:7601 serves this vault with the registered worker key
[buyer] decision: BUY (payback 3.2 days is under 30)
[buyer] funding from eth:usdc with NEAR Intents 1Click (dry quote, mainnet, nothing is deposited):
[buyer]   pay 3.035842 USDC on eth (about 3.03 USD) -> receive 3.0 USDC on NEAR at 2e365a12...
[buyer] buying: ft_transfer_call 3 tUSDC to deed2.deedlab.testnet with msg {"buy":{"token_id":"relay-...","max_price":"3000000","listing_id":1}}
[buyer] bought: https://testnet.nearblocks.io/txns/...
[buyer] deed owner now deedlab-buyer.testnet, vault owner now deedlab-buyer.testnet (epoch 2, locked false)
```

The funding quote is a real 1Click quote with `"dry": true`: it shows what paying from Ethereum
would cost, but no deposit address exists and nothing moves. The purchase itself uses tUSDC.

### 8. The seller's withdraw reverts

```
[owner deedlab-seller.testnet] withdraw: FAILED https://testnet.nearblocks.io/txns/... (... "Smart contract panicked: only the deed owner")
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

## What it shows

- The token is the business: the buyer gets the cash, the revenue from the next charge on and
  the customer ledger, and the seller's withdraw fails.
- One key rotation moves the work to a new server; the old one stops by itself.
- Paid obligations survive the move: nothing is lost, nothing is charged twice.
- An agent can value and buy a business from on-chain data alone.
