#!/usr/bin/env node
// Deploys tUSDC and the token to testnet sub-accounts of the parent account.
// Creates the sub-accounts if needed (new keys go to the legacy keychain with mode 600),
// deploys only when the code on chain differs from the local build, initializes once,
// and registers the token on tUSDC so it can receive sale payments.
//
// Env: OUTLIVE_PARENT (default outlive.testnet), OUTLIVE_ACCOUNT, TUSDC_ACCOUNT.
// A token with incompatible state goes to a new account name; the previous deployment record
// is kept under "superseded" in deployments/testnet.json.

import {
  NEAR, TGAS, account, accountExists, actions, addressLink, call, newKeyPair, provider,
  saveKeyPair, send, txLink, view,
} from "./lib/near.mjs";
import { codeHash, loadDeployments, readWasm, saveDeployments } from "./lib/deployments.mjs";

const PARENT = process.env.OUTLIVE_PARENT || "outlive.testnet";
// outlive.<parent> runs the Phase A code; the reviewed code (new state layout) lives on outlive2.
const OUTLIVE_ID = process.env.OUTLIVE_ACCOUNT || `outlive2.${PARENT}`;
const TUSDC_ID = process.env.TUSDC_ACCOUNT || `tusdc.${PARENT}`;
const FT_STORAGE = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR

// Code storage costs 1 NEAR per 100 KB. Fund each account with its code size plus a margin
// for state and for the token's callbacks and refunds.
const STATE_MARGIN = { [TUSDC_ID]: NEAR / 4n, [OUTLIVE_ID]: NEAR / 2n };

const steps = [];
function record(step, result) {
  const entry = { step, hash: result.hash, link: txLink(result.hash), success: result.success };
  steps.push(entry);
  console.log(`${result.success ? "ok  " : "FAIL"} ${step}  ${entry.link}`);
  if (!result.success) {
    console.error(JSON.stringify(result.failure || result.receiptFailures, null, 2));
    throw new Error(`${step} failed`);
  }
}

async function ensureAccount(id, wasmBytes) {
  if (await accountExists(id)) {
    console.log(`reuse ${id}`);
    return;
  }
  const funding = BigInt(wasmBytes.length) * 10n ** 19n + STATE_MARGIN[id];
  const kp = newKeyPair();
  saveKeyPair(id, kp); // store first so the key is never lost
  const parent = account(PARENT);
  const res = await send(parent, id, [
    actions.createAccount(),
    actions.transfer(funding),
    actions.addFullAccessKey(kp.getPublicKey()),
  ]);
  record(`create ${id}`, res);
}

async function isInitialized(id, probe) {
  try {
    await view(id, probe);
    return true;
  } catch {
    return false;
  }
}

async function ensureCode(id, wasmBytes, probe, initArgs) {
  const local = codeHash(wasmBytes).sha256_base58;
  const onChain = (await provider.viewAccount({ accountId: id })).code_hash;
  const initialized = onChain !== "11111111111111111111111111111111" && (await isInitialized(id, probe));
  if (onChain === local && initialized) {
    console.log(`code of ${id} is current (${local})`);
    return;
  }
  const txActions = [actions.deployContract(new Uint8Array(wasmBytes))];
  if (!initialized) txActions.push(actions.functionCall("new", initArgs, 100n * TGAS, 0n));
  record(`${initialized ? "redeploy" : "deploy and init"} ${id}`, await send(account(id), id, txActions));
}

async function main() {
  const tusdcWasm = readWasm("tusdc");
  const outliveWasm = readWasm("outlive");
  const vaultWasm = readWasm("vault");

  await ensureAccount(TUSDC_ID, tusdcWasm);
  await ensureCode(TUSDC_ID, tusdcWasm, "ft_metadata", {});
  await ensureAccount(OUTLIVE_ID, outliveWasm);
  await ensureCode(OUTLIVE_ID, outliveWasm, "get_config", {
    admin_id: PARENT,
    payment_token: TUSDC_ID,
    payment_symbol: "tUSDC",
  });

  const registered = await view(TUSDC_ID, "storage_balance_of", { account_id: OUTLIVE_ID });
  if (!registered) {
    const res = await call(account(PARENT), TUSDC_ID, "storage_deposit",
      { account_id: OUTLIVE_ID, registration_only: true }, { gas: 30n * TGAS, deposit: FT_STORAGE });
    record(`register ${OUTLIVE_ID} on ${TUSDC_ID}`, res);
  }

  const advertised = await view(OUTLIVE_ID, "vault_code_hash");
  const vaultLocal = codeHash(vaultWasm);
  if (advertised.sha256_base58 !== vaultLocal.sha256_base58) {
    throw new Error("outlive on chain embeds a different vault build than contracts/target/near/vault");
  }

  const data = loadDeployments();
  const previousOutlive = data.accounts && data.accounts.outlive;
  if (previousOutlive && previousOutlive !== OUTLIVE_ID) {
    data.superseded = [
      ...(data.superseded || []),
      {
        outlive: previousOutlive,
        vault: data.accounts.vault,
        code_hashes: data.code_hashes,
        deploy: data.deploy,
        smoke: data.smoke,
        superseded_at: new Date().toISOString(),
        reason: `replaced by ${OUTLIVE_ID} (new state layout after the self-review fixes, see docs/SECURITY.md)`,
      },
    ];
    delete data.deploy;
    delete data.smoke;
    delete data.accounts.vault;
  }
  data.network = "testnet";
  data.explorer = "https://testnet.nearblocks.io";
  data.accounts = {
    ...(data.accounts || {}),
    parent: PARENT,
    outlive: OUTLIVE_ID,
    tusdc: TUSDC_ID,
  };
  data.links = {
    ...(data.links || {}),
    outlive: addressLink(OUTLIVE_ID),
    tusdc: addressLink(TUSDC_ID),
  };
  data.code_hashes = {
    outlive: codeHash(outliveWasm),
    vault: vaultLocal,
    tusdc: codeHash(tusdcWasm),
  };
  data.mint_cost_yocto = await view(OUTLIVE_ID, "mint_cost");
  data.deploy = [...(data.deploy || []), ...steps.map((s) => ({ ...s, at: new Date().toISOString() }))];
  saveDeployments(data);
  console.log(`deployments/testnet.json updated (${steps.length} new transactions)`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
