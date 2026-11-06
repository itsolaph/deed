// What the worker needs from chain, behind an interface so tests can use a fake vault.

import { Rpc, VaultViews, type ChargeItem, type ChargeResult, type CustomerView, type VaultInfo, type WorkerKeyView, withRpcRetry } from "@outlive/sdk";
import { NodeSigner } from "@outlive/sdk/node";

export type KeyPermission = "full" | "function_call" | null;

export interface ChargeOutcome {
  /** false when the transaction failed as a whole (nothing was charged). */
  ok: boolean;
  hash?: string;
  results: ChargeResult[];
  error?: string;
}

export interface VaultChain {
  readonly vault: string;
  info(): Promise<VaultInfo>;
  customer(accountId: string): Promise<CustomerView | null>;
  workerHistory(): Promise<WorkerKeyView[]>;
  /** Permission of `publicKey` on `accountId`, or null if the key does not exist. */
  keyPermission(accountId: string, publicKey: string): Promise<KeyPermission>;
  /** Remaining allowance of the worker key in yoctoNEAR, or null if unknown or unlimited. */
  workerAllowance(publicKey: string): Promise<bigint | null>;
  /** Sends `charge` signed as the vault with the worker key. */
  charge(items: ChargeItem[]): Promise<ChargeOutcome>;
}

export class RpcVaultChain implements VaultChain {
  private readonly views: VaultViews;
  private protocolVersion: number | undefined;
  private readonly signer: NodeSigner;

  constructor(
    readonly vault: string,
    private readonly rpc: Rpc,
    workerPrivateKey: string,
    private readonly chargeGasTgas: number,
  ) {
    this.views = new VaultViews(rpc, vault);
    this.signer = new NodeSigner(vault, workerPrivateKey, rpc.urls);
  }

  async info() {
    const info = await this.views.info();
    this.protocolVersion = info.protocol_version ?? 1;
    return info;
  }

  customer(accountId: string) {
    return this.views.customer(accountId);
  }

  workerHistory() {
    return this.views.workerHistory();
  }

  async keyPermission(accountId: string, publicKey: string): Promise<KeyPermission> {
    const key = await this.rpc.accessKey(accountId, publicKey);
    if (!key) return null;
    return key.permission === "FullAccess" ? "full" : "function_call";
  }

  async workerAllowance(publicKey: string): Promise<bigint | null> {
    const key = await this.rpc.accessKey(this.vault, publicKey);
    if (!key || key.permission === "FullAccess") return null;
    const a = key.permission.FunctionCall.allowance;
    return a === null ? null : BigInt(a);
  }

  async charge(items: ChargeItem[]): Promise<ChargeOutcome> {
    try {
      if (this.protocolVersion === undefined) await this.info();
      // v1 ignores the added field and still settles at execution-time price.
      // Only an explicit v2 capability guarantees exact quote settlement.
      if (this.protocolVersion === 2 && items.some(i =>
        typeof i.quoted_price !== "string" || !/^[0-9]+$/.test(i.quoted_price) ||
        BigInt(i.quoted_price) <= 0n || BigInt(i.quoted_price) >= (1n << 128n))) {
        return { ok: false, results: [], error: "v2 requires an explicit positive U128 quoted_price" };
      }
      const out = await withRpcRetry(() => this.signer.call(this.vault, {
        method: "charge",
        args: { items },
        gasTgas: this.chargeGasTgas,
        depositYocto: 0n,
      })); // transient RPC errors retry inside withRpcRetry

      if (!out.success) return { ok: false, hash: out.hash, results: [], error: out.error ?? "charge failed" };
      return { ok: true, hash: out.hash, results: out.value as ChargeResult[] };
    } catch (e) {
      return { ok: false, results: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
}
