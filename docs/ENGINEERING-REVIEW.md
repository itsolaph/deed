# Core engineering review

This pass hardened the working testnet prototype. It did not change the contracts, record a
new video, send a submission or publish a social post. This is a project self-review assisted
by models, not an independent security audit.

## What changed

- Customer resubmission and signed handoff share one per-delivery admission. Concurrent callers
  cannot allocate multiple charge sequences for the same obligation.
- Receipt v2 binds the canonical complete request, including method, headers and idempotency.
  Conflicting idempotency reuse returns HTTP 409. The SDK checks response IDs and receipt
  vault/customer/key as well as attempt proofs.
- Retirement cannot allocate a charge after a pending customer read resumes.
- Ambiguous, malformed or incomplete charge responses stay retryable with their original
  sequences. A stale RPC ledger does not remove confirmed reservations until it includes their
  sequence. Confirmed responses reserve actual chain cost; duplicates with unknown original
  debit wait for an inclusive ledger before new admissions.
- Temporary payment, cap, refund and retirement rejections keep customer obligations in the
  persistent store, including after client restart.
- Journal recovery repairs a torn final record before appending, preserves complete final JSON,
  refuses corrupt complete records, and synchronizes appends.
- The buyer checks exact vault identity, healthy/accepting status and finite payback limits.
  Missing indexed transaction bodies cannot count as completely verified funding.

## Executed checks

| Check | Result |
|---|---|
| Contract wasm builds | vault, Outlive and tUSDC built successfully |
| Rust unit tests | 41 passed; one SVG preview intentionally ignored |
| near-workspaces sandbox | 19 passed |
| Node suites after the final accounting changes | 90 passed: SDK 35, worker 44, agents 7, web 4 |
| Static web build | TypeScript and Vite passed |
| Script syntax and whitespace checks | passed |
| Deployed contract code hashes | all three matched the locally built wasm |
| Public relay, unfunded customer | HTTP 402 with payment instructions |
| Public relay, funded customer after worker restart | HTTP 202, then delivered HTTP 200 with a valid proof |

The regressions were run against the missing behavior first and failed before implementation.
Tests live in `worker/test/hardening.test.ts`, `worker/test/journal.test.ts`,
`sdk/test/client-binding.test.ts`, `sdk/test/appraisal.test.ts` and `agents/test/agents.test.ts`.
The hostile-seller test still verifies that a refunding customer's uncharged credit is retained;
its old expectation that a temporary refund request permanently discards the receipt was corrected.

## Testnet sale and continuity run

Recorded run: `relay-11061040`, under `demo` in `deployments/testnet.json`. All 18 recorded steps
passed. The run used receipt-v2 workers; subsequent stale-view and response-binding refinements
were checked separately by the final Node suites and live relay smoke test.

- [Purchase](https://testnet.nearblocks.io/txns/BUJBsUnEtyUFSwEE69PRWFyB9dzSQNSDTjjDNrWdPoGB)
- [Former seller's withdraw rejected](https://testnet.nearblocks.io/txns/4G1rjqd5UmYzdkQUPV2QRp3zGngTRwRCTAros9ZqHcvT)
- [Worker rotation](https://testnet.nearblocks.io/txns/BX7NLa2znf5qvNnazqFhYq2svm5vuYx5FEYiTMkPcJUL)
- Handoff: 40 of 40 obligations accepted, zero rejected. Of these, 24 had not been charged by
  the previous worker and were charged as new; the rest were delivered without a second bill.
- During the post-sale traffic phase, 80 accepted deliveries completed, zero failed, zero pending.
- [Buyer's revenue withdrawal](https://testnet.nearblocks.io/txns/3LAUzm91VKNbkYYp5DSrKLLNAerUjnmazXQJnCa8t2Zz)
- Final owner epoch: 2. Final revenue balance after withdrawal: zero; customer liabilities
  remained separate. Demo-owned local processes stopped at completion.

Traffic came from project-run agents, not external demand. The buyer used the explicitly
relaxed demo policy. The dry Intents quote did not execute a mainnet payment.

## Boundaries, not solved by this pass

1. **Receipt compatibility:** v1 signatures remain cryptographically verifiable, but unbound v1
   requests cannot safely be taken over. Drain old obligations before upgrading; local journal
   replay is not migration of a customer's old receipt. The public worker had no pending jobs
   before its upgrade.
2. **Price settlement:** existing vaults debit the execution-time price. The signed admission
   quote is not a price lock. Exact accepted-price settlement requires a new contract API;
   draining before price changes mitigates normal operation but cannot retract an in-flight tx.
3. **Concurrent rotations:** optimistic key/history publication has a conditional failed-callback
   ordering hazard. The complete on-chain failure/interleaving was not reproduced, so this is
   not presented as a demonstrated exploit. Serialize rotations and read back actual account
   keys and vault state. Existing vaults cannot be upgraded by redeploying the factory.
4. The worker remains trusted for honest delivery and billing within customer caps. At-least-once
   delivery, one-hop funding attribution and the registry's preparation-time upgrade key remain
   documented limits. No mainnet-readiness or independent-audit claim is made.

## Hackathon fit

The [official rules](https://nearhackathon.com/HACKATHON.md) allow testnet-only prototypes and do
not mandate Intents or TEE. The [NFT track example](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/10-nfts.md)
asks for the token/account relationship, transfer-control explanation, holder access, earnings
history and transfer-path tests. Those are present; the strongest next engineering work is
contract-level price/rotation hardening for a versioned vault, not adding an unrelated integration.

The public demo and repository remain the entry points. Submission, video and X are separate work.
