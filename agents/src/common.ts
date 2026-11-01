// Shared helpers for the agents: accounts from deployments/testnet.json, keys from the
// legacy keychain (never printed), links, and testnet tUSDC top-ups.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Rpc, TESTNET_EXPLORER, rpcUrlsFor, signerFromSecretKey, type Signer } from "@deed/sdk";
import { NodeSigner, keychainFile, readKeyFile, type TxOutcome } from "@deed/sdk/node";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const DEPLOYMENTS_FILE = path.join(ROOT, "deployments", "testnet.json");
export const NETWORK = process.env.NEAR_NETWORK || "testnet";

export interface Deployments {
  accounts: { deed: string; tusdc: string; seller: string; buyer: string; alice: string; bob: string; [k: string]: string };
  [key: string]: unknown;
}

export function loadDeployments(): Deployments {
  return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8")) as Deployments;
}

export function rpc(): Rpc {
  return new Rpc(process.env.NEAR_RPC_URLS ? process.env.NEAR_RPC_URLS.split(",") : rpcUrlsFor(NETWORK));
}

/**
 * Runs `fn`, retrying transient RPC failures (public testnet endpoints answer
 * 429/503 in bursts, and failover alone is not enough when every URL is busy).
 * A send that failed before acceptance never lands, so retrying is safe.
 */
export async function withRpcRetry<T>(fn: () => Promise<T>, attempts = 4, onRetry?: (line: string) => void): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (i >= attempts || !/429|too many requests|fetch failed|econnreset|etimeout|timeout|503|exceeded \d+ providers|rate limit/i.test(msg)) throw e;
      onRetry?.(`transient RPC error (${msg.slice(0, 90)}); retry ${i} of ${attempts - 1} in ${5 * i}s`);
      await new Promise((r) => setTimeout(r, 5000 * i));
    }
  }
}

/** Signs transactions as `accountId` with its key from the legacy keychain. */
export function txSigner(accountId: string, keyFile?: string): NodeSigner {
  const key = readKeyFile(keyFile ?? keychainFile(accountId, NETWORK));
  return new NodeSigner(accountId, key.private_key, rpc().urls);
}

/** NEP-413 signer for `accountId` (its full-access key from the keychain). */
export function messageSigner(accountId: string): Signer {
  return signerFromSecretKey(readKeyFile(keychainFile(accountId, NETWORK)).private_key);
}

export function txLink(hash: string): string {
  return `${TESTNET_EXPLORER}/txns/${hash}`;
}

export function addressLink(account: string): string {
  return `${TESTNET_EXPLORER}/address/${account}`;
}

export function clock(): string {
  return new Date().toISOString().slice(11, 19);
}

export async function tokenMeta(r: Rpc, token: string): Promise<{ decimals: number; symbol: string }> {
  const m = await r.view<{ decimals: number; symbol: string }>(token, "ft_metadata");
  return { decimals: m.decimals, symbol: m.symbol };
}

export async function tokenBalance(r: Rpc, token: string, account: string): Promise<bigint> {
  return BigInt(await r.view<string>(token, "ft_balance_of", { account_id: account }));
}

const TUSDC_MINT_MAX = 1_000_000_000n; // 1,000 tUSDC per call
const STORAGE_DEPOSIT_YOCTO = 1_250_000_000_000_000_000_000n; // 0.00125 NEAR

/** Testnet only: registers `account` on tUSDC and mints until it holds `amount`. */
export async function ensureTusdc(r: Rpc, token: string, account: string, amount: bigint): Promise<TxOutcome[]> {
  const out: TxOutcome[] = [];
  const signer = txSigner(account);
  const registered = await r.view<unknown>(token, "storage_balance_of", { account_id: account });
  if (!registered) {
    out.push(await signer.call(token, { method: "storage_deposit", args: { account_id: account, registration_only: true }, gasTgas: 30, depositYocto: STORAGE_DEPOSIT_YOCTO }));
  }
  let balance = await tokenBalance(r, token, account);
  while (balance < amount) {
    const need = amount - balance;
    const mint = need > TUSDC_MINT_MAX ? TUSDC_MINT_MAX : need;
    const res = await signer.call(token, { method: "mint", args: { amount: mint.toString() }, gasTgas: 30, depositYocto: 0n });
    out.push(res);
    if (!res.success) throw new Error(`tUSDC mint failed: ${res.error}`);
    balance += mint;
  }
  return out;
}

/** True when the module at `metaUrl` is the script node was started with. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(fileURLToPath(metaUrl)) === fs.realpathSync(entry);
  } catch {
    return false;
  }
}

export function runMain(name: string, main: () => Promise<void>): void {
  main().catch((e) => {
    process.stderr.write(`${name}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

/** Writes a JSON file for the demo script to pick up. */
export function writeJson(file: string | undefined, data: unknown): void {
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}
