# Try it as a customer (10 minutes)

This page is for someone outside the project who wants to pay the hosted relay on testnet and
see what a customer gets: an HTTP 402 with the exact way to pay, a signed receipt for every
accepted job, a signed proof of every delivery attempt, and a refund of unspent credit.

Everything here is testnet. The payment token, tUSDC, is a test token without value that anyone
can mint.

The hosted relay is the token `relay-live` on `outlive2.outlive.testnet`; its vault is
`relay-live.outlive2.outlive.testnet`. The worker URL is not written here because it changes (it
runs behind a temporary tunnel): every step reads it from the vault's on-chain config, the same
way the SDK does.

## What you need

- Node 22 or newer, this repository, and `npm ci && npm run build` once (about a minute).
- A testnet account whose full-access key is in the near-cli legacy keychain
  (`~/.near-credentials/testnet/<account>.json`). If you have none, the faucet makes one with a
  few NEAR for gas:

  ```
  near account create-account sponsor-by-faucet-service <you>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
  ```

  (`near` is [near-cli-rs](https://github.com/near/near-cli-rs), tested with 0.30.)

## 1. Read the endpoint from chain

```
near contract call-function as-read-only relay-live.outlive2.outlive.testnet get_info json-args {} network-config testnet now
```

`endpoint` is the worker URL, `price_per_call` the price in tUSDC units (6 decimals, so `10000`
is 0.01 tUSDC), `min_deposit` the smallest first deposit (1 tUSDC). `examples/customer.mjs`
reads the same view.

## 2. Ask without credit: HTTP 402

```
node examples/customer.mjs --account <you>.testnet
```

Expected output (the endpoint differs):

```
vault relay-live.outlive2.outlive.testnet: endpoint on chain https://<tunnel>.trycloudflare.com, price 0.01 tUSDC per call, first deposit at least 1 tUSDC
402 payment required (unknown_customer). The worker says how to pay:
{
  "contract": "tusdc.outlive.testnet",
  "method": "ft_transfer_call",
  "args": { "receiver_id": "relay-live.outlive2.outlive.testnet", "amount": "1000000", "msg": "" },
  ...
  "near_cli": "near contract call-function as-transaction tusdc.outlive.testnet ft_transfer_call ..."
}
```

The request was signed with your key (NEP-413), so the worker knows who asked; you have no
credit in the vault, so it refuses before doing any work.

## 3. Get tUSDC, register, prepay, send a job

```
node examples/customer.mjs --account <you>.testnet --fund 2
```

This does four things, each a transaction with a link:

1. `storage_deposit` on `tusdc.outlive.testnet` (0.00125 NEAR) so your account can hold tUSDC.
2. `mint` 2 tUSDC from the token's public test faucet. The example refuses more than 5; one
   call costs 0.01, so 2 tUSDC is 200 calls. Please do not mint large amounts.
3. `ft_transfer_call` of 2 tUSDC to the vault: your prepaid credit. It belongs to you, the
   token owner can never withdraw it, and the worker can only charge it per call within your
   daily cap.
4. A webhook job: the worker POSTs a small JSON body to `--target` (default
   `https://httpbin.org/post`; use any public URL that accepts POST, private addresses are
   refused).

Expected output:

```
storage_deposit on tusdc.outlive.testnet: ok https://testnet.nearblocks.io/txns/...
mint 2 tUSDC (public test faucet): ok https://testnet.nearblocks.io/txns/...
ft_transfer_call 2 tUSDC to the vault as prepaid credit: ok https://testnet.nearblocks.io/txns/...
202 accepted d_8ac5...: receipt seq 22, price 0.01 tUSDC, signed by worker key ed25519:7NXg... (checked against the vault's worker keys)
attempt 1: HTTP 200, response sha256 e0d5af57a9373e1a..., proof signature valid
state: delivered
```

The receipt is the worker's signed promise (delivery id, your account, the charge sequence
number, price, hashes of target and body). The SDK checks that its key is, or was, a worker key
registered in the vault (`get_worker_history`). Each attempt carries a proof signed by the same
key. The charge for the call lands on chain in the worker's next batch (`vault_charge` event on
the vault, visible on NearBlocks).

Receipts are kept in `examples/.receipts/<you>.testnet.json` until delivered. If the worker
disappears, the SDK reads the endpoint again from the vault and presents them to the new
worker (`OutliveClient.resubmit`); a job already charged is then delivered without a second charge.

## 4. Optional: take your money back

```
node examples/customer.mjs --account <you>.testnet --refund
```

This calls `request_refund` and prints when the refund becomes available (the vault's refund
delay, 10 minutes on this vault). The worker may still charge calls it already served during the
delay; it accepts no new ones. After the delay:

```
node examples/customer.mjs --account <you>.testnet --claim
```

`claim_refund` sends your whole remaining credit back with `ft_transfer`.

## With the SDK in your own code

The example is the SDK with defaults filled in. The core is:

```js
import { OutliveClient, Rpc, signerFromSecretKey } from "../sdk/dist/src/index.js";
import { NodeSigner, createNodeTransactor, fileStore } from "../sdk/dist/src/node.js";

const client = new OutliveClient({
  vault: "relay-live.outlive2.outlive.testnet",
  accountId: "you.testnet",
  signer: signerFromSecretKey(secretKey),                 // NEP-413 request signing
  rpc: new Rpc(),
  transactor: createNodeTransactor(new NodeSigner("you.testnet", secretKey)),
  store: fileStore("receipts.json"),                      // open receipts survive restarts
});
await client.topUp(2_000_000n);                           // ft_transfer_call, 2 tUSDC
const { delivery_id, receipt } = await client.deliver({ url, method: "POST", headers: {}, body, idempotency_key });
await client.track();                                     // polls, verifies proofs, re-presents after a move
```

## What this does not show

- The hosted worker is the project's own process on one machine behind a temporary tunnel. It
  can be down. It is trusted off-chain software: it could accept a job and not deliver it; the
  receipt and the missing proof would show that, and your daily cap and refund limit the loss.
- Traffic you see on the board from `outlive-alice`, `outlive-bob` and `outlive-seller*`, `outlive-hostile` and `outlive-wash` accounts
  is the project's own demo traffic. The web app marks those customers.
