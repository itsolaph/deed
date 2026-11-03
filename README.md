<p align="center"><img src="docs/card.svg" width="820" height="220" alt="Deed: an NFT that owns a running paid API on NEAR"></p>

# Deed

Deed is an NFT that owns a transferable service instance of a running paid API: the vault that
holds its treasury, price list, customer ledger and worker key is a NEAR sub-account the token
controls. Selling the token moves that instance to the buyer while customers keep calling it.
The demo service is a durable webhook relay that agents pay per delivery; the demo buyer is
itself an agent that attributes the vault's on-chain revenue to independent customers, computes
payback on chain-visible costs, and buys. Testnet only. Built for the NEAR hackathon (November
2026), tracks `nfts` and `business`.

## Try it

| Do | See | Time |
|---|---|---|
| `npm ci && bash scripts/check.sh` | Contract wasm builds, 41 contract unit tests, 19 sandbox integration tests (near-workspaces), 52 Node tests (sdk 28, worker 19, agents 5) and the web build pass; ends with `== all checks passed`. `SKIP_SANDBOX=1` skips the sandbox tests (they download `neard` once). | 3 to 6 min |
| `npm run build && node agents/dist/src/buyer.js --account <any testnet account> --dry-run` | Read only. The buyer agent prints its policy (strict by default), then for every listing on `deed2.deedlab.testnet`: each customer with its paid revenue and whether it counts as independent, the payback on chain-visible costs, every check with pass/FAIL and the reason, and its decision. The listings on testnet today are past demo runs; each is skipped with its reasons (too few independent customers, too young, worker stopped). | 15 s |
| `node examples/customer.mjs --account <you>.testnet`, then `--fund 2` | Become a paying customer of the hosted relay: HTTP 402 with the exact payment call, then mint test tUSDC, prepay, a signed receipt and a signed delivery proof. See [docs/TRY-AS-CUSTOMER.md](docs/TRY-AS-CUSTOMER.md). | 10 min |
| `npm run dev -w web`, open http://127.0.0.1:7650 | Every deed with live figures and its on-chain certificate. Open one for its earnings history per holder, its customers (our demo traffic agents marked), and for a listing the payback on chain-visible costs with the worked formula. Connect a testnet wallet to buy, list, withdraw, rotate the worker or manage relay credit. `npm run build -w web` writes a static site to `web/dist/`. | 1 min |
| Open `deployments/testnet.json` | Every recorded testnet run with transaction links: `demo`, `hostileSeller`, `washReject`. | |
| `bash scripts/demo-testnet.sh` (funded accounts, see below) | The whole story on testnet: worker A and traffic, revenue ticking, listing, the buyer agent (demo policy, printed) buying, the seller's withdraw reverting, worker B taking over, open deliveries delivered, the buyer withdrawing. Prints a link at every step, ends with `Demo passed`, stops every process it started. | 8 to 16 min |
| `bash scripts/hostile-seller.sh` | The seller kills its worker with SIGKILL after the sale, with jobs in flight. Prints jobs in flight at the kill, delivered by the buyer's worker, refunded, and double charges (0), each with links. | about 20 min (10 are the refund delay) |
| `node scripts/wash-reject.mjs` | The seller pays its own vault through two accounts it funded; the buyer agent, even with the demo policy, answers SKIP: "revenue from owner-funded customers excluded". | 4 min |
| `node scripts/theft-proof.mjs` | Six unauthorized actions against the hosted vault (worker key withdraws, sends NEAR, adds a full-access key, calls the token; a stranger withdraws; an old worker key charges), each rejected on testnet. Needs the vault's worker key file, so it runs on the operator's machine. | 30 s |
| `node agents/dist/src/withdraw-xchain.js --vault <vault> --to eth:usdc --recipient 0x...` | A NEAR Intents 1Click mainnet dry quote (`dry: true`), nothing executed, for paying vault revenue out to another chain, and the exact `withdraw` call it would make. | 5 s |
| `bash scripts/smoke-testnet.sh` | The contract-only story on testnet (mint, charge, list, buy, rotate) with assertions. | 3 min |

Toolchain (pinned): Node 22 or newer (tested with 26.12), npm, TypeScript 5.9.3, near-api-js
7.4.0, Vite 7.3.7. Contracts: Rust stable (tested with 1.99) with the `wasm32-unknown-unknown`
target, `cargo-near` 0.22.0, near-sdk 5.30.0, near-workspaces 0.24.0. `near` CLI: near-cli-rs
0.30 (only to create accounts). Settings the scripts read are listed in
[`.env.example`](.env.example); copy it to `.env` (git-ignored) or export them. Keys never go
there: they stay in the near-cli legacy keychain (`~/.near-credentials/testnet/<account>.json`).

The testnet scripts need accounts with keys in that keychain: a seller with about 3.5 NEAR
(each run mints a new deed for 2.88 NEAR; use a fresh one per run) and a buyer, alice and bob
with about 1 NEAR each. Create them with
`near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`
and pass them as `DEMO_SELLER`, `DEMO_BUYER`, `DEMO_ALICE`, `DEMO_BOB` (or `HOSTILE_SELLER`,
`WASH_SELLER`). tUSDC is minted for them automatically (anyone can mint up to 1,000 per call).
The scripts reach the public testnet RPC and the FastNEAR transaction index; set `NEAR_RPC_URLS`
if you have your own RPC.

## Claims and proof

| Claim | Test or script | Testnet transaction or log | Video |
|---|---|---|---|
| Minting creates the vault sub-account with no full-access key, in one batch | sandbox `mint_creates_vault_without_full_access_key` | demo mint [34S7Fe…](https://testnet.nearblocks.io/txns/34S7FeZ1fc1bQv4dHUmCY11f6ubhctRr9hzKr3Q6sf5r) | TBD |
| Only the worker key can charge, only within each customer's balance and daily cap, never one seq twice | sandbox `only_the_worker_key_can_charge`, `seq_caps_and_balance_rules`; ledger unit tests | worker A's charge [9xBRsX…](https://testnet.nearblocks.io/txns/9xBRsXfny8CapwFSrmSjwiBgN1R1E9xgB1KatYpdwy3p) | TBD |
| Six unauthorized actions against a vault are rejected on testnet | `scripts/theft-proof.mjs` | stranger's withdraw rejected by the contract: [3ZARmS…](https://testnet.nearblocks.io/txns/3ZARmSniQehNWMReyEADnUvJtyDZASn4VpkU1qCCdD9f) (the other five are refused before execution and leave no transaction) | TBD |
| A listing locks the vault; a sale moves the token, the vault owner and the revenue; the seller's withdraw then reverts | sandbox `listing_locks_owner_actions_and_cancel_unlocks`, `buy_moves_the_business_and_rotation_hands_over_the_worker` | list [7gsv5E…](https://testnet.nearblocks.io/txns/7gsv5EojrbKYKGs4MQAxD51mxbAL57LawFLhgvf46m9c), buy [v2ty1Y…](https://testnet.nearblocks.io/txns/v2ty1Yv86qX62FbsTqLaU8yXTa88e4SuVBjgghNBXED), the seller's withdraw reverts [39fQiK…](https://testnet.nearblocks.io/txns/39fQiK98qxZL6kPH9mwn8miyXXVCoiSiJnQ2Vcn2nvnD) | TBD |
| Customer credit is never withdrawable by the owner and comes back to the customer after the refund delay | sandbox `withdraw_rules`, `refund_delay_claim_and_cancel_by_deposit`, `third_party_deposit_does_not_cancel_a_refund_request` | bob's refund request [2bePEp…](https://testnet.nearblocks.io/txns/2bePEps9BjogecpvWHpWrhRoo2n3E5MHJHdAFUBs92fZ) and claim [3kF65x…](https://testnet.nearblocks.io/txns/3kF65xRXtGC4gz7CCxbBU2ff8MQK3XsU75BahytmPD1H); quickstart claim [D85NtM…](https://testnet.nearblocks.io/txns/D85NtMusXpBjh6weJPvsLohaj1FisiG4R7MyuBPgAnSJ) | TBD |
| Unknown customers get HTTP 402 with the exact payment call; requests are NEP-413 signed; every accepted job has a signed receipt and every attempt a signed proof | worker test `paid delivery: 402 first, then receipt, retries, signed proofs, one charge per delivery` | quickstart against the hosted relay: deposit [GcktwF…](https://testnet.nearblocks.io/txns/GcktwF7oq8sfwMTaXxoHsYPTixPo5yT4RFSm7V8SphwW) | TBD |
| A key rotation moves the work to a new worker; open obligations move with it; nothing is charged twice | worker tests `handover: …`, `delivered but uncharged work is handed over …` | rotation [Ai6eou…](https://testnet.nearblocks.io/txns/Ai6eou54iAhaA2tf3kdp89EowKMf7TVNdUQecgj4ubzn), worker B's charge [JD99Ne…](https://testnet.nearblocks.io/txns/JD99NeTceMUQ7EF33oARm8Da2UrGkqrqwcNiMFvJ1nLx); 25 of 25 obligations handed over (demo log) | TBD |
| If the seller kills its worker without a hand-off, customers resubmit their receipts to the buyer's worker: charged jobs are delivered without a second charge, uncharged ones are charged once, unspent credit stays refundable; 0 double charges | worker test `hostile seller: worker A killed without hand-off; …`; `scripts/hostile-seller.sh` | run `hostile-1103c`: 10 jobs in flight at the kill, 8 of them delivered by B (plus 2 new calls), 2 refunded, 0 double charges; rotation [xeMWP3…](https://testnet.nearblocks.io/txns/xeMWP37Q7UAFT9YtuKkoWp9AC7uZQrbzEa4wtz2tAYy), B's charge [F7nDmo…](https://testnet.nearblocks.io/txns/F7nDmoKJQx5D4Lc14GR1yrr6LLbCFJeAm4xAmNRqMKfx); all in `deployments/testnet.json` `hostileSeller` | TBD |
| The buyer agent counts only revenue from independent customers and skips owner-funded revenue | `sdk/test/appraisal.test.ts` (one test per gate and exclusion); `scripts/wash-reject.mjs` | run `wash-1103a`: owner-funded deposits [Cy5eL7…](https://testnet.nearblocks.io/txns/Cy5eL7CbxuZQVYv74DrxtVkkXcRnm2zC1w6GSX7DiPRi) and [JEEQsG…](https://testnet.nearblocks.io/txns/JEEQsGsSnSGWrAdeMf3N8H6u6VtencgVseYesDARzqgE), listing [8AAV2N…](https://testnet.nearblocks.io/txns/8AAV2NZdo8YGJ8MscADZ1WVrKNrgamUWYHgRzvKfN6Rx); the agent's SKIP is in `deployments/testnet.json` `washReject` | TBD |
| An agent appraises and buys a listed deed from on-chain data (demo policy, printed) | agents test `buyer: …`; `scripts/demo-testnet.sh` | run `relay-1103hard`: buy [v2ty1Y…](https://testnet.nearblocks.io/txns/v2ty1Yv86qX62FbsTqLaU8yXTa88e4SuVBjgghNBXED) (payback on chain-visible costs 4.12 days on 0.69 tUSDC of independent revenue) | TBD |
| Each holder's earnings are reconstructed per ownership epoch from NEP-297 events and match the vault's counters | `sdk/test/history.test.ts` (recorded fixture) | web app, "Earnings history" in any deed | TBD |
| 1Click quotes are mainnet dry quotes (`dry: true`), nothing executed | agents test `1Click: asset lookup, NEAR price and dry quote requests` (refuses `dry: false`) | demo run: `demo.buyer.funding_quote` (3.035391 USDC from Ethereum for 3 USDC on NEAR; no transaction exists, by design) | TBD |

## NEAR features used

| Feature | Where it is exercised |
|---|---|
| NEP-171 core, NEP-177 metadata, NEP-181 enumeration | `contracts/deed/src/nft.rs`, `contracts/deed/src/views.rs`; every mint and sale |
| NEP-297 events (`deed_*`, `vault_*`, NEP-171 and NEP-141 events) | `contracts/deed/src/events.rs`, `contracts/vault/src/events.rs`; read back by `sdk/src/history.ts` (earnings history) and `sdk/src/appraisal.ts` (per-customer revenue, who paid credit in) |
| NEP-413 signed messages for API authentication | `sdk/src/nep413.ts`, `worker/src/auth.ts`; every relay request |
| NEP-141 `ft_transfer_call` as the payment path (customer credit, deed purchase), NEP-145 storage, NEP-148 metadata | `contracts/vault/src/customer.rs`, `contracts/deed/src/sale.rs`, `contracts/tusdc/src/lib.rs`, `sdk/src/client.ts` |
| Sub-accounts created by a contract (one vault per token, created, deployed and initialized in one batch) | `contracts/deed/src/mint.rs` |
| Function-call access keys (the worker key may only call `charge` on the vault; the vault adds and deletes it itself) | `contracts/vault/src/owner.rs` (`set_worker`), `worker/src/vault-chain.ts`, `scripts/theft-proof.mjs` |
| Dynamic NFT metadata (on-chain SVG certificate built from pushed stats) | `contracts/deed/src/svg.rs`, `contracts/vault/src/hooks.rs` (`push_stats`) |
| NEAR Intents 1Click API, mainnet dry quotes only (`dry: true`, nothing executed): fund a purchase from another chain, pay revenue out to another chain | `agents/src/oneclick.ts`, `agents/src/buyer.ts`, `agents/src/withdraw-xchain.ts` |
| NEAR Connect wallet connector | `web/src/wallet.ts` |

Not used: gas keys (NEP-611), global contracts (NEP-591), Chain Signatures. See "Limits".

## Not claimed

- No NEAR Intents payment was executed. Every 1Click result here is a mainnet dry quote
  (`dry: true`); nothing was deposited, swapped or sent.
- No TEE. The worker's image hash in the vault is a published claim, not attested.
- No Chain Signatures.
- Testnet only, with a test token (tUSDC) anyone can mint.
- Traffic in the recorded demos comes from the project's own agents (`deedlab-alice`,
  `deedlab-bob`, and accounts funded by `deedl*-seller` accounts) unless shown otherwise; the
  web app marks them. The payback figures in the demos are figures of that traffic, not evidence
  of demand.
- Payback is payback on chain-visible costs: revenue minus on-chain gas. Hosting, bandwidth and
  operator time are not included.
- The worker is trusted off-chain software. It can take a paid job and not deliver it; signed
  receipts and missing proofs make that visible, daily caps and refunds limit it, and nothing
  on chain prevents it. A buyer gets the vault, not the servers, domains or code.
- The deed is a transferable service instance, not a legal transfer of a business.
- "Six unauthorized actions rejected on testnet" covers those six actions; it is not a proof
  that no other path exists, and the contracts have had no independent audit.
- The deed account's full-access key: removed before submission, see
  `deployments/testnet.json` `deedKeys`.

## How it works

```
 seller / buyer --- NEP-171 token ---> deed contract ---- owner push (epoch) ----> vault <slug>.<deed>
                    built-in sale       (registry,          lock / unlock            treasury, price,
                    ft_transfer_call     factory, sale,                              customer ledger,
                    {"buy": ...}         dynamic NFT)  <---- on_stats -------------  worker key
                                                                                        ^
 customers (SDK) -- NEP-413 signed request --> worker (gateway + relay + charger) -------+ charge,
                <-- 402 / receipt / proofs --       signs as the vault with a            signed as the
                                                    function-call key limited to charge   vault
```

1. `mint` on the deed contract creates the vault sub-account `<slug>.<deed>` in one batch
   (create account, deploy the vault code, init) and mints the token only after that succeeded.
   The vault has no full-access key, ever.
2. Customers prepay credit in the payment token (`ft_transfer_call` to the vault) and call the
   worker with NEP-413 signed requests. Unknown or unfunded customers get HTTP 402 with the exact
   call to make.
3. The worker accepts a delivery, signs an obligation receipt, delivers with retries, signs a
   proof of every attempt, and charges the vault in batches with its function-call key. Charges
   move credit to revenue within each customer's balance and daily cap.
4. The token holder withdraws revenue. Listing the token locks the vault (no withdraw, no key
   rotation, no price change). A buyer pays through `ft_transfer_call` on the payment token; the
   deed moves the token, pushes the new owner to the vault and pays the seller.
5. From the next charge on, revenue belongs to the buyer and the seller's withdraw reverts. The
   buyer starts a worker and rotates the worker key and endpoint in one transaction. The old
   worker sees it on chain, hands its open obligations to the new endpoint and exits. If the
   seller kills it instead, customers present their receipts to the new endpoint themselves.

More detail: [docs/DESIGN.md](docs/DESIGN.md) (design, buyer appraisal, hostile seller, threat
model), [docs/CONTRACTS.md](docs/CONTRACTS.md) (every method and invariant),
[docs/DEMO.md](docs/DEMO.md) (the runs step by step), [docs/SECURITY.md](docs/SECURITY.md),
[docs/TRY-AS-CUSTOMER.md](docs/TRY-AS-CUSTOMER.md).

Running a worker yourself: `node worker/dist/src/cli.js --vault <vault> --network testnet --port 7601`.
It reads price, endpoint, worker key and payment token from chain and refuses to start unless
its key file holds the vault's registered worker key.

## What moves with the token

Enforced by the contracts, so it moves without trusting the seller:

- **Treasury.** Withdrawable proceeds stay in the vault and belong to whoever holds the token.
- **Price list.** The price per call; increases take effect only after a 24-hour notice.
- **Customer ledger.** Every customer's prepaid credit, daily cap and sequence number. Customer
  credit is a liability, never withdrawable by the owner; customers can always take it back
  after the refund delay (10 minutes).
- **Worker authorization.** The only key on the vault is the worker's function-call key. The
  token holder replaces it; the old key is deleted in the same step.

Not enforced, and said plainly:

- **The hosting.** Servers, domains, code and uptime are off chain. After a sale the seller's
  worker keeps serving (for the buyer's revenue) until the buyer rotates the key, or the seller
  kills it; see [the hostile-seller analysis](docs/DESIGN.md#hostile-seller-the-old-worker-is-killed-not-handed-off).
- **The image hash** in the vault is a published claim about the worker code, not verified.
- **Delivery.** A worker can take a paid delivery and not deliver it. Signed receipts and
  proofs make that visible, caps and refunds limit it.

## Testnet deployment

| | |
|---|---|
| Deed contract | [`deed2.deedlab.testnet`](https://testnet.nearblocks.io/address/deed2.deedlab.testnet) |
| Payment token (tUSDC, test only) | [`tusdc.deedlab.testnet`](https://testnet.nearblocks.io/address/tusdc.deedlab.testnet) |
| Hosted relay (customer quickstart) | [`relay-live.deed2.deedlab.testnet`](https://testnet.nearblocks.io/address/relay-live.deed2.deedlab.testnet); endpoint in its `get_info` |
| Code hashes | in [`deployments/testnet.json`](deployments/testnet.json); `vault_code_hash()` on the deed returns the hash every vault runs |

The recorded runs, with every transaction, are in `deployments/testnet.json` (`demo`,
`hostileSeller`, `washReject`) and summarized in [docs/DEMO.md](docs/DEMO.md).

## Limits

- Testnet only, with a test token. Nothing here has been audited; the contract review in
  [docs/SECURITY.md](docs/SECURITY.md) is a self-review.
- One worker per vault at a time, one charge transaction at a time (a single access key nonce).
  NEP-611 gas keys would allow parallel charge lanes; they are not used yet because a gas key
  holds its own NEAR balance that the vault would have to fund and refill.
- Each vault is a full contract deployment (about 2.3 NEAR of storage). NEP-591 global
  contracts would make vaults cheap at scale, but publishing one costs about 10 NEAR per 100 KB
  once, so for a handful of deeds per-vault deployment is cheaper.
- Wash revenue: the buyer agent excludes owners, previous owners and customers they funded (one
  hop) and wants several independent payers, but funding through intermediaries or recruited
  third parties is not caught.
- The demo policy relaxes the buyer's thresholds so a 10-minute run can buy; the agent prints
  that every time. With the default strict policy no demo vault would be bought.
- Deliveries are at least once: after a handover a delivery can reach its target twice. It is
  never charged twice.
- A job charged by a worker that was then killed is made good only if the customer still has
  its receipt; there is no on-chain clawback.

## Roadmap

- Mainnet with native USDC and the deed account locked (no full-access key) or DAO-controlled.
- TEE-attested workers, so the image hash becomes a verified fact instead of a claim.
- An uptime bond the owner posts in the vault, slashed when signed receipts show unserved work.
- NEP-591 global contracts for vault code once there are many deeds; NEP-611 gas keys for
  parallel charge lanes.

## Credits

Third-party libraries, each under its own licence:

- [near-sdk-rs and near-contract-standards](https://github.com/near/near-sdk-rs) (MIT or Apache-2.0)
- [near-workspaces-rs](https://github.com/near/near-workspaces-rs) and [near-sandbox-rs](https://github.com/near/near-sandbox-rs) (MIT or Apache-2.0), tests only
- [cargo-near](https://github.com/near/cargo-near) (MIT or Apache-2.0), build tool
- [near-api-js](https://github.com/near/near-api-js) (MIT and Apache-2.0)
- [@noble/curves](https://github.com/paulmillr/noble-curves), [@noble/hashes](https://github.com/paulmillr/noble-hashes), [@scure/base](https://github.com/paulmillr/scure-base) (MIT)
- [@hot-labs/near-connect](https://github.com/hot-dao/near-selector) (MIT)
- [Vite](https://github.com/vitejs/vite) (MIT) and [TypeScript](https://github.com/microsoft/TypeScript) (Apache-2.0), build tools
- [NEAR Intents 1Click API](https://docs.near-intents.org/) for dry quotes

All code in this repository was written for this project.

## Licence

MIT. See [LICENSE](LICENSE).
