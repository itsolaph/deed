// NEP-413 request authentication. A request is accepted when:
// - the signature over (method, path, body sha256, timestamp) with recipient = the vault
//   checks out for the public key in the headers;
// - the timestamp is within 5 minutes of the worker clock;
// - the nonce was not seen before (nonces are kept for the whole window);
// - the public key is a full-access key of the claimed account (RPC, cached briefly).
//   NEP-413 asks for full-access keys: a function-call key that some app holds must not be
//   able to spend the account's relay credit.

import { AUTH_WINDOW_MS, authMessage, parseAuthHeaders, sha256Hex, toBase64, verifyPayload } from "@deed/sdk";
import type { VaultChain } from "./vault-chain.js";

export const KEY_CACHE_MS = 60_000;

export type AuthResult = { ok: true; accountId: string } | { ok: false; status: number; error: string };

export class Authenticator {
  private readonly nonces = new Map<string, number>();
  private readonly keyCache = new Map<string, { at: number; full: boolean }>();

  constructor(
    private readonly vault: string,
    private readonly chain: Pick<VaultChain, "keyPermission">,
    private readonly now: () => number = Date.now,
  ) {}

  async verify(headers: Record<string, string | string[] | undefined>, method: string, path: string, body: Uint8Array): Promise<AuthResult> {
    const parsed = parseAuthHeaders(headers);
    if (typeof parsed === "string") return { ok: false, status: 401, error: parsed };
    const now = this.now();
    if (Math.abs(now - parsed.timestamp) > AUTH_WINDOW_MS) return { ok: false, status: 401, error: "timestamp outside the 5 minute window" };

    const message = authMessage(method, path, sha256Hex(body), parsed.timestamp);
    if (!verifyPayload(parsed.publicKey, { message, nonce: parsed.nonce, recipient: this.vault }, parsed.signature)) {
      return { ok: false, status: 401, error: "bad NEP-413 signature" };
    }

    this.sweepNonces(now);
    const nonceKey = toBase64(parsed.nonce);
    if (this.nonces.has(nonceKey)) return { ok: false, status: 401, error: "nonce already used" };

    const full = await this.isFullAccessKey(parsed.accountId, parsed.publicKey, now);
    if (!full) return { ok: false, status: 401, error: "public key is not a full-access key of the account" };

    // Record the nonce only after every check passed, so a bad request cannot burn it.
    this.nonces.set(nonceKey, now + 2 * AUTH_WINDOW_MS);
    return { ok: true, accountId: parsed.accountId };
  }

  private async isFullAccessKey(accountId: string, publicKey: string, now: number): Promise<boolean> {
    const cacheKey = `${accountId} ${publicKey}`;
    const hit = this.keyCache.get(cacheKey);
    if (hit && now - hit.at < KEY_CACHE_MS) return hit.full;
    let full: boolean;
    try {
      full = (await this.chain.keyPermission(accountId, publicKey)) === "full";
    } catch {
      return false; // RPC trouble: refuse this request, but do not cache the answer.
    }
    this.keyCache.set(cacheKey, { at: now, full });
    return full;
  }

  private sweepNonces(now: number): void {
    for (const [nonce, expires] of this.nonces) if (expires < now) this.nonces.delete(nonce);
  }
}
