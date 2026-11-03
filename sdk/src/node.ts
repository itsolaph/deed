// Node-only helpers: keys from the near-cli legacy keychain and on-chain transactions with
// near-api-js. Never prints key material.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Account, FailoverRpcProvider, JsonRpcProvider, actions } from "near-api-js";
import { TESTNET_RPC_URLS } from "./chain.js";
import type { PendingStore, Transactor } from "./client.js";
import type { ObligationEntry } from "./relay.js";

export const TGAS = 1_000_000_000_000n;

export function credentialsDir(): string {
  return process.env.NEAR_CREDENTIALS_DIR || path.join(os.homedir(), ".near-credentials");
}

export function keychainFile(accountId: string, network = "testnet"): string {
  return path.join(credentialsDir(), network, `${accountId}.json`);
}

export interface KeyFile {
  account_id?: string;
  public_key: string;
  private_key: string;
}

export function readKeyFile(file: string): KeyFile {
  if (!fs.existsSync(file)) throw new Error(`key file not found: ${displayPath(file)}`);
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<KeyFile> & { secret_key?: string };
  const privateKey = json.private_key ?? json.secret_key;
  if (!privateKey || !json.public_key) throw new Error(`key file ${displayPath(file)} has no key pair`);
  return { account_id: json.account_id, public_key: json.public_key, private_key: privateKey };
}

/** Writes a key file with mode 600. Refuses to overwrite. */
export function writeKeyFile(file: string, key: KeyFile): void {
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite ${displayPath(file)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(key), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** Shows paths under the home directory as ~/... so logs never contain absolute home paths. */
export function displayPath(file: string): string {
  const home = os.homedir();
  return file.startsWith(home) ? "~" + file.slice(home.length) : file;
}

export function nearProvider(urls: string[] = TESTNET_RPC_URLS) {
  return new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url })));
}

export interface TxOutcome {
  hash: string;
  success: boolean;
  value: unknown;
  error?: string;
  logs: string[];
}

function decode(b64: string | undefined): unknown {
  if (!b64) return null;
  const text = Buffer.from(b64, "base64").toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// near-api-js result types differ between versions; only the fields used here are typed.
interface RawOutcome {
  transaction: { hash: string };
  status: { SuccessValue?: string; Failure?: unknown } | string;
  receipts_outcome?: { outcome: { logs: string[]; status: { Failure?: unknown } } }[];
}

export function summarizeOutcome(raw: unknown): TxOutcome {
  const res = raw as RawOutcome;
  const status = typeof res.status === "object" ? res.status : {};
  const logs: string[] = [];
  let receiptFailure: unknown;
  for (const r of res.receipts_outcome ?? []) {
    logs.push(...r.outcome.logs);
    if (r.outcome.status?.Failure && !receiptFailure) receiptFailure = r.outcome.status.Failure;
  }
  const success = status.SuccessValue !== undefined;
  const failure = status.Failure ?? receiptFailure;
  return {
    hash: res.transaction.hash,
    success,
    value: decode(status.SuccessValue),
    ...(success ? {} : { error: JSON.stringify(failure ?? res.status) }),
    logs,
  };
}

export interface FunctionCall {
  method: string;
  args: Record<string, unknown>;
  gasTgas: number;
  depositYocto: bigint;
}

/** Signs as `accountId` with `privateKey` and sends function calls to `receiverId` in one tx. */
export class NodeSigner {
  private readonly account: Account;

  constructor(
    readonly accountId: string,
    privateKey: string,
    rpcUrls: string[] = TESTNET_RPC_URLS,
  ) {
    this.account = new Account(accountId, nearProvider(rpcUrls), privateKey as `ed25519:${string}`);
  }

  async callMany(receiverId: string, calls: FunctionCall[]): Promise<TxOutcome> {
    const res = await this.account.signAndSendTransaction({
      receiverId,
      actions: calls.map((c) => actions.functionCall(c.method, c.args, BigInt(c.gasTgas) * TGAS, c.depositYocto)),
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    return summarizeOutcome(res);
  }

  call(receiverId: string, call: FunctionCall): Promise<TxOutcome> {
    return this.callMany(receiverId, [call]);
  }
}

/**
 * Keeps a client's open obligations in a JSON file (mode 600), written on every change, so a
 * customer process that restarts (or a different machine) can still resubmit its receipts.
 * The file holds receipts and request bodies, no keys.
 */
export function fileStore(file: string): PendingStore {
  return {
    load(): ObligationEntry[] {
      if (!fs.existsSync(file)) return [];
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: ObligationEntry[] };
        return Array.isArray(data.entries) ? data.entries : [];
      } catch {
        return [];
      }
    },
    save(entries: ObligationEntry[]): void {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ saved_at: new Date().toISOString(), entries }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

export function createNodeTransactor(signer: NodeSigner): Transactor {
  return async (c) => {
    const out = await signer.call(c.contractId, {
      method: c.method,
      args: c.args,
      gasTgas: c.gasTgas,
      depositYocto: c.depositYocto,
    });
    return { hash: out.hash, success: out.success, ...(out.error ? { error: out.error } : {}) };
  };
}
