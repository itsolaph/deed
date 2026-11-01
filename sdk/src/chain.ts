// Minimal NEAR JSON-RPC client over fetch (browser and Node). Read-only: views, access keys,
// account state. Transactions are signed elsewhere (near-api-js in Node, a wallet in the web app).

export const TESTNET_RPC_URLS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const MAINNET_RPC_URLS = ["https://free.rpc.fastnear.com", "https://rpc.mainnet.near.org"];
export const TESTNET_EXPLORER = "https://testnet.nearblocks.io";

export function rpcUrlsFor(network: string): string[] {
  if (network === "mainnet") return MAINNET_RPC_URLS;
  if (network === "testnet") return TESTNET_RPC_URLS;
  throw new Error(`unknown network ${network}`);
}

export interface AccessKeyInfo {
  public_key: string;
  access_key: {
    nonce: number;
    permission:
      | "FullAccess"
      | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
  };
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 15_000;

export class Rpc {
  private id = 0;

  constructor(readonly urls: string[] = TESTNET_RPC_URLS) {
    if (urls.length === 0) throw new Error("no RPC urls");
  }

  /** Calls `method` on each URL in order until one answers. Contract errors are not retried. */
  async request<T>(method: string, params: unknown): Promise<T> {
    // Public testnet RPCs answer 429/503 in bursts; every request here is a read,
    // so the whole failover loop is safe to retry with backoff.
    return withRpcRetry(async () => {
      let lastError: unknown;
      for (const url of this.urls) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (!res.ok) throw new Error(`RPC ${url} answered HTTP ${res.status}`);
          const body = (await res.json()) as { result?: T & { error?: string }; error?: { message?: string; data?: unknown; cause?: { name?: string } } };
          if (body.error) {
            const name = body.error.cause?.name ?? "";
            // A missing account or key is an answer, not an outage: do not try the next URL.
            throw new RpcError(`${name || "RPC error"}: ${JSON.stringify(body.error.data ?? body.error.message)}`, body.error);
          }
          if (body.result && typeof body.result === "object" && "error" in body.result && body.result.error) {
            throw new RpcError(String(body.result.error));
          }
          return body.result as T;
        } catch (e) {
          if (e instanceof RpcError) throw e;
          lastError = e;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    });
  }

  async view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const argsBase64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(args))));
    const result = await this.request<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: method,
      args_base64: argsBase64,
    });
    const text = new TextDecoder().decode(Uint8Array.from(result.result));
    return (text ? JSON.parse(text) : null) as T;
  }

  async accessKeys(accountId: string): Promise<AccessKeyInfo[]> {
    const result = await this.request<{ keys: AccessKeyInfo[] }>("query", {
      request_type: "view_access_key_list",
      finality: "final",
      account_id: accountId,
    });
    return result.keys;
  }

  async accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo["access_key"] | null> {
    try {
      return await this.request<AccessKeyInfo["access_key"]>("query", {
        request_type: "view_access_key",
        finality: "final",
        account_id: accountId,
        public_key: publicKey,
      });
    } catch (e) {
      if (e instanceof RpcError && /UNKNOWN_ACCESS_KEY|does not exist|AccessKeyDoesNotExist/i.test(e.message)) return null;
      throw e;
    }
  }

  async account(accountId: string): Promise<{ amount: string; locked: string; code_hash: string; storage_usage: number }> {
    return this.request("query", { request_type: "view_account", finality: "final", account_id: accountId });
  }
}

/**
 * Runs `fn`, retrying transient RPC failures (public testnet endpoints answer
 * 429/503 in bursts; a send rejected before acceptance never lands, so
 * retrying is safe). Shared by the agents and the worker.
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
