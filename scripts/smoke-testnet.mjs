#!/usr/bin/env node
// Testnet smoke run of the whole contract story with the real accounts:
// mint, worker key, customer credit, charge, withdraw, list, buy, handover, rotation.
// Every transaction is checked against its expected outcome and recorded with its
// nearblocks link in deployments/testnet.json (section "smoke").
//
// Env: SMOKE_SLUG (default relay), DEED_ACCOUNT, TUSDC_ACCOUNT, and the account names below.

import crypto from "node:crypto";
import { Account } from "near-api-js";
import {
  ONE_YOCTO, TGAS, account, call, hasKey, newKeyPair, provider, replaceKeyPair, saveKeyPair,
  txLink, view,
} from "./lib/near.mjs";
import { loadDeployments, saveDeployments } from "./lib/deployments.mjs";

const SLUG = process.env.SMOKE_SLUG || "relay";
const DEED = process.env.DEED_ACCOUNT || "deed.deedlab.testnet";
const TUSDC = process.env.TUSDC_ACCOUNT || "tusdc.deedlab.testnet";
const SELLER = process.env.SELLER_ACCOUNT || "deedlab-seller.testnet";
const BUYER = process.env.BUYER_ACCOUNT || "deedlab-buyer.testnet";
const ALICE = process.env.ALICE_ACCOUNT || "deedlab-alice.testnet";
const BOB = process.env.BOB_ACCOUNT || "deedlab-bob.testnet";
const VAULT = `${SLUG}.${DEED}`;

const U = 1_000_000n; // one tUSDC
const PRICE_PER_CALL = 10_000n; // 0.01 tUSDC
const DAILY_CAP = 20n * U;
const SALE_PRICE = 25n * U;
const FT_STORAGE = 1_250_000_000_000_000_000_000n;
const CHARGE_GAS = 50n * TGAS;
const BIG_GAS = 300n * TGAS;

const steps = [];

function show(n) {
  const s = n.toString().padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)} tUSDC`;
}

async function step(name, actor, expect, run) {
  let res;
  try {
    res = await run();
  } catch (e) {
    // Rejected before reaching the chain (for example a deleted access key): no tx hash exists.
    const text = `${e.name || ""} ${e.message || e}`;
    const error = /access key .* does not exist|AccessKeyDoesNotExist/i.test(text)
      ? "AccessKeyDoesNotExist"
      : e.type || e.name || String(e);
    const entry = { step: name, actor, expected: expect, outcome: "rejected_by_rpc", error };
    steps.push(entry);
    console.log(`${expect === "failure" ? "ok  " : "FAIL"} ${name}  (rejected by RPC: ${entry.error})`);
    if (expect !== "failure") throw e;
    return null;
  }
  const outcome = res.success ? "success" : "failure";
  const entry = { step: name, actor, expected: expect, outcome, hash: res.hash, link: txLink(res.hash) };
  steps.push(entry);
  const good = outcome === expect;
  console.log(`${good ? "ok  " : "FAIL"} ${name}  ${entry.link}`);
  if (!good) {
    console.error(JSON.stringify(res.failure || res.receiptFailures, null, 2));
    throw new Error(`step "${name}" expected ${expect}, got ${outcome}`);
  }
  return res;
}

async function ftBalance(id) {
  return BigInt(await view(TUSDC, "ft_balance_of", { account_id: id }));
}

async function ensureRegistered(id) {
  if (await view(TUSDC, "storage_balance_of", { account_id: id })) return;
  await step(`register ${id} on tUSDC`, id, "success", () =>
    call(account(id), TUSDC, "storage_deposit", { account_id: id, registration_only: true },
      { gas: 30n * TGAS, deposit: FT_STORAGE }));
}

async function faucet(id, amount) {
  await step(`${id} mints ${show(amount)}`, id, "success", () =>
    call(account(id), TUSDC, "mint", { amount: amount.toString() }, { gas: 30n * TGAS }));
}

async function deposit(id, amount) {
  await step(`${id} deposits ${show(amount)} credit`, id, "success", () =>
    call(account(id), TUSDC, "ft_transfer_call",
      { receiver_id: VAULT, amount: amount.toString(), msg: "" }, { gas: BIG_GAS, deposit: ONE_YOCTO }));
}

async function nextSeq(id) {
  const c = await view(VAULT, "get_customer", { account_id: id });
  return Number(c.last_seq) + 1;
}

function receiptsRoot(label) {
  return crypto.createHash("sha256").update(`smoke:${label}`).digest("hex");
}

async function chargeItems(specs) {
  const items = [];
  for (const [customer, units] of specs) {
    const seq = await nextSeq(customer);
    items.push({ customer, seq, units, receipts_root: receiptsRoot(`${customer}:${seq}`) });
  }
  return items;
}

function charge(workerKey, items) {
  return call(account(VAULT, workerKey), VAULT, "charge", { items }, { gas: CHARGE_GAS });
}

async function revenue() {
  return BigInt((await view(VAULT, "get_info")).revenue);
}

function withdraw(id, amount) {
  return call(account(id), VAULT, "withdraw", { amount: amount.toString() }, { gas: BIG_GAS, deposit: ONE_YOCTO });
}

async function assertInvariant(label) {
  const info = await view(VAULT, "get_info");
  const held = await ftBalance(VAULT);
  const owed = BigInt(info.liabilities) + BigInt(info.revenue) + BigInt(info.in_flight);
  if (held !== owed) throw new Error(`invariant broken after ${label}: ${held} != ${owed}`);
  console.log(`     invariant holds after ${label}: vault holds ${show(held)}`);
}

async function main() {
  if (await view(DEED, "get_deed", { token_id: SLUG })) {
    throw new Error(`deed "${SLUG}" already exists; set SMOKE_SLUG to a new slug for another run`);
  }
  if (hasKey(VAULT)) throw new Error(`a key file for ${VAULT} already exists in the keychain`);

  // 1. Seller mints the deed. The vault sub-account is created by the deed contract.
  const cost = BigInt(await view(DEED, "mint_cost"));
  const minted = await step(`${SELLER} mints deed "${SLUG}"`, SELLER, "success", () =>
    call(account(SELLER), DEED, "mint", {
      slug: SLUG,
      title: "Durable Webhook Relay",
      price_per_call: PRICE_PER_CALL.toString(),
      endpoint: "https://relay.deed.example/v1",
      image_hash: "",
      default_daily_cap: DAILY_CAP.toString(),
    }, { gas: BIG_GAS, deposit: cost }));
  if (minted.value !== true) throw new Error("mint callback reported failure");
  const keys = await new Account(VAULT, provider).getAccessKeyList();
  if (keys.keys.length !== 0) throw new Error("vault must start without keys");
  console.log(`     vault ${VAULT} has no access keys`);

  // 2. Seller registers worker A's key. The key file lets the worker sign as the vault.
  const workerA = newKeyPair();
  saveKeyPair(VAULT, workerA);
  const setA = await step(`${SELLER} sets worker key A`, SELLER, "success", () =>
    call(account(SELLER), VAULT, "set_worker", { public_key: workerA.getPublicKey().toString() },
      { gas: BIG_GAS, deposit: ONE_YOCTO }));
  if (setA.value !== true) throw new Error("set_worker callback reported failure");

  // 3. Customers get tUSDC and prepay credit.
  for (const id of [SELLER, BUYER, ALICE, BOB]) await ensureRegistered(id);
  await faucet(ALICE, 100n * U);
  await faucet(BOB, 100n * U);
  await deposit(ALICE, 20n * U);
  await deposit(BOB, 10n * U);
  await assertInvariant("deposits");

  // 4. Worker A charges a batch.
  const batch1 = await chargeItems([[ALICE, 40], [BOB, 25]]);
  const c1 = await step("worker key A charges a batch (65 calls)", VAULT, "success", () =>
    charge(workerA.toString(), batch1));
  console.log(`     results: ${c1.value.map((r) => `${r.customer} ${r.status}`).join(", ")}`);
  await assertInvariant("charge");

  // 5. Seller withdraws revenue; a customer cannot.
  const earned = await revenue();
  await step(`${SELLER} withdraws ${show(earned)}`, SELLER, "success", () => withdraw(SELLER, earned));
  await step(`${ALICE} tries to withdraw (must fail)`, ALICE, "failure", () => withdraw(ALICE, 1n));

  // 6. More traffic, then the seller lists the deed. The vault is now locked.
  const batch2 = await chargeItems([[ALICE, 10]]);
  await step("worker key A charges (10 calls)", VAULT, "success", () => charge(workerA.toString(), batch2));
  const listed = await step(`${SELLER} lists the deed for ${show(SALE_PRICE)}`, SELLER, "success", () =>
    call(account(SELLER), DEED, "list", { token_id: SLUG, price: SALE_PRICE.toString() },
      { gas: BIG_GAS, deposit: ONE_YOCTO }));
  if (listed.value !== true) throw new Error("listing did not become active");
  await step(`${SELLER} tries to withdraw while listed (must fail)`, SELLER, "failure", () =>
    withdraw(SELLER, 1n));

  // 7. Buyer buys with tUSDC through ft_transfer_call, sending 1 tUSDC too much.
  await faucet(BUYER, 100n * U);
  const buyerBefore = await ftBalance(BUYER);
  const sellerBefore = await ftBalance(SELLER);
  const msg = JSON.stringify({ buy: { token_id: SLUG, max_price: SALE_PRICE.toString() } });
  await step(`${BUYER} buys the deed`, BUYER, "success", () =>
    call(account(BUYER), TUSDC, "ft_transfer_call",
      { receiver_id: DEED, amount: (SALE_PRICE + U).toString(), msg }, { gas: BIG_GAS, deposit: ONE_YOCTO }));
  const paid = buyerBefore - (await ftBalance(BUYER));
  const received = (await ftBalance(SELLER)) - sellerBefore;
  const info = await view(VAULT, "get_info");
  const token = await view(DEED, "nft_token", { token_id: SLUG });
  console.log(`     buyer paid ${show(paid)}, seller received ${show(received)}`);
  console.log(`     token owner ${token.owner_id}, vault owner ${info.owner_id} (epoch ${info.owner_epoch}, locked ${info.locked})`);
  if (paid !== SALE_PRICE || received !== SALE_PRICE || token.owner_id !== BUYER || info.owner_id !== BUYER || info.locked) {
    throw new Error("sale did not settle as expected");
  }

  // 8. The seller's withdraw now reverts. The next call's revenue accrues to the buyer.
  await step(`${SELLER} tries to withdraw after the sale (must fail)`, SELLER, "failure", () =>
    withdraw(SELLER, 1n));
  const batch3 = await chargeItems([[ALICE, 5], [BOB, 5]]);
  await step("worker key A keeps charging after the sale (10 calls)", VAULT, "success", () =>
    charge(workerA.toString(), batch3));
  const buyerRevenue = await revenue();
  await step(`${BUYER} withdraws ${show(buyerRevenue)}`, BUYER, "success", () => withdraw(BUYER, buyerRevenue));
  await assertInvariant("buyer withdraw");

  // 9. Buyer rotates the worker key to their own server's key B.
  const workerB = newKeyPair();
  const setB = await step(`${BUYER} rotates the worker key to B`, BUYER, "success", () =>
    call(account(BUYER), VAULT, "set_worker", { public_key: workerB.getPublicKey().toString() },
      { gas: BIG_GAS, deposit: ONE_YOCTO }));
  if (setB.value !== true) throw new Error("rotation callback reported failure");
  replaceKeyPair(VAULT, workerB);
  const keysAfter = (await new Account(VAULT, provider).getAccessKeyList()).keys;
  const onlyB = keysAfter.length === 1 && keysAfter[0].public_key === workerB.getPublicKey().toString();
  if (!onlyB) throw new Error("after rotation the vault must hold exactly worker key B");
  console.log("     vault keys after rotation: only key B, function-call, methods [charge]");
  const batch4 = await chargeItems([[ALICE, 1]]);
  await step("old worker key A tries to charge (must fail)", VAULT, "failure", () =>
    charge(workerA.toString(), batch4));
  await step("new worker key B charges", VAULT, "success", () => charge(workerB.toString(), batch4));
  await assertInvariant("rotation");

  const finalInfo = await view(VAULT, "get_info");
  const data = loadDeployments();
  data.accounts = { ...(data.accounts || {}), seller: SELLER, buyer: BUYER, alice: ALICE, bob: BOB, vault: VAULT };
  data.smoke = {
    run_at: new Date().toISOString(),
    slug: SLUG,
    vault: VAULT,
    sale_price: SALE_PRICE.toString(),
    price_per_call: PRICE_PER_CALL.toString(),
    final_vault_owner: finalInfo.owner_id,
    final_owner_epoch: finalInfo.owner_epoch,
    final_worker_key: finalInfo.worker_key,
    access_keys_after_rotation: keysAfter.map((k) => ({ public_key: k.public_key, permission: k.access_key.permission })),
    steps,
  };
  saveDeployments(data);
  console.log(`smoke run passed: ${steps.length} steps recorded in deployments/testnet.json`);
}

main().catch((e) => {
  console.error(`smoke run failed: ${e.message || e}`);
  process.exit(1);
});
