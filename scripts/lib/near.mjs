// Small helpers around near-api-js for the testnet scripts.
// Keys are read at runtime from the near-cli legacy keychain and are never printed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, actions } from "near-api-js";

// rpc.testnet.near.org answers 429 "deprecated" to some requests, so FastNEAR goes first.
export const RPC_URLS = (process.env.NEAR_RPC_URLS || "https://test.rpc.fastnear.com,https://rpc.testnet.near.org")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);
export const EXPLORER = "https://testnet.nearblocks.io";
export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
export const NEAR = 10n ** 24n;

export const provider = new FailoverRpcProvider(RPC_URLS.map((url) => new JsonRpcProvider({ url })));

export function credentialsDir() {
  return process.env.NEAR_CREDENTIALS_DIR || path.join(os.homedir(), ".near-credentials");
}

function keyFile(accountId, network = "testnet") {
  return path.join(credentialsDir(), network, `${accountId}.json`);
}

export function hasKey(accountId) {
  return fs.existsSync(keyFile(accountId));
}

export function loadPrivateKey(accountId) {
  const file = keyFile(accountId);
  if (!fs.existsSync(file)) {
    throw new Error(`no key for ${accountId} in the legacy keychain (${path.join("~", ".near-credentials")})`);
  }
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = json.private_key || json.secret_key;
  if (!key) throw new Error(`key file for ${accountId} has no private_key`);
  return key;
}

/** Stores a new key pair for `accountId` with mode 600. Refuses to overwrite. */
export function saveKeyPair(accountId, keyPair) {
  const file = keyFile(accountId);
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite the existing key file for ${accountId}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const body = {
    account_id: accountId,
    public_key: keyPair.getPublicKey().toString(),
    private_key: keyPair.toString(),
  };
  fs.writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Replaces the stored key of `accountId` after a worker key rotation (old key is useless). */
export function replaceKeyPair(accountId, keyPair) {
  const file = keyFile(accountId);
  if (fs.existsSync(file)) fs.rmSync(file);
  saveKeyPair(accountId, keyPair);
}

export function newKeyPair() {
  return KeyPair.fromRandom("ed25519");
}

export function account(accountId, privateKey = loadPrivateKey(accountId)) {
  return new Account(accountId, provider, privateKey);
}

export async function accountExists(accountId) {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

export async function view(contractId, method, args = {}) {
  return provider.callFunction({ contractId, method, args });
}

export function txLink(hash) {
  return `${EXPLORER}/txns/${hash}`;
}

export function addressLink(accountId) {
  return `${EXPLORER}/address/${accountId}`;
}

function decodeValue(b64) {
  if (!b64) return null;
  const text = Buffer.from(b64, "base64").toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Summarizes an RPC transaction response: hash, final success, returned value, failures, logs. */
export function summarize(res) {
  const failures = [];
  const logs = [];
  for (const r of res.receipts_outcome || []) {
    logs.push(...r.outcome.logs);
    if (r.outcome.status && r.outcome.status.Failure) failures.push(r.outcome.status.Failure);
  }
  const status = res.status || {};
  return {
    hash: res.transaction.hash,
    success: status.SuccessValue !== undefined,
    value: decodeValue(status.SuccessValue),
    failure: status.Failure || null,
    receiptFailures: failures,
    logs,
  };
}

/** Signs and sends a batch, never throwing on an on-chain failure (the result says so). */
export async function send(signer, receiverId, txActions) {
  const res = await signer.signAndSendTransaction({
    receiverId,
    actions: txActions,
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  return summarize(res);
}

export async function call(signer, contractId, method, args = {}, { gas = 100n * TGAS, deposit = 0n } = {}) {
  return send(signer, contractId, [actions.functionCall(method, args, gas, deposit)]);
}

export { actions, KeyPair };
