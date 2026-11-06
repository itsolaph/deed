// NEP-413 signed messages, used to authenticate customer requests to a worker.
// Spec: https://github.com/near/NEPs/blob/master/neps/nep-0413.md
// The signature is ed25519 over sha256(borsh(tag, payload)), tag = 2^31 + 413.

import { concatBytes, fromBase64, randomBytes, sha256Bytes, sha256Hex, toBase64, utf8 } from "./encoding.js";
import { Signer, verifySignature } from "./keys.js";

export const NEP413_TAG = 2 ** 31 + 413;
export const NONCE_BYTES = 32;
/** Requests whose timestamp is further than this from the worker's clock are refused. */
export const AUTH_WINDOW_MS = 5 * 60 * 1000;
export const AUTH_MESSAGE_PREFIX = "outlive-relay-auth:v1";

export interface Nep413Payload {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
}

function borshString(s: string): Uint8Array {
  const bytes = utf8(s);
  return concatBytes(u32(bytes.length), bytes);
}

/** Borsh bytes of the tagged payload, before hashing. */
export function serializePayload(p: Nep413Payload): Uint8Array {
  if (p.nonce.length !== NONCE_BYTES) throw new Error("nonce must be 32 bytes");
  const callback =
    p.callbackUrl == null ? new Uint8Array([0]) : concatBytes(new Uint8Array([1]), borshString(p.callbackUrl));
  return concatBytes(u32(NEP413_TAG), borshString(p.message), p.nonce, borshString(p.recipient), callback);
}

export function payloadHash(p: Nep413Payload): Uint8Array {
  return sha256Bytes(serializePayload(p));
}

export function signPayload(signer: Signer, p: Nep413Payload): Uint8Array {
  return signer.sign(payloadHash(p));
}

export function verifyPayload(publicKey: string, p: Nep413Payload, signature: Uint8Array): boolean {
  return verifySignature(publicKey, payloadHash(p), signature);
}

/** The text a customer signs for one HTTP request. */
export function authMessage(method: string, path: string, bodySha256: string, timestampMs: number): string {
  return [AUTH_MESSAGE_PREFIX, method.toUpperCase(), path, bodySha256, String(timestampMs)].join("\n");
}

export const AUTH_HEADERS = {
  account: "x-outlive-account",
  publicKey: "x-outlive-public-key",
  signature: "x-outlive-signature",
  nonce: "x-outlive-nonce",
  timestamp: "x-outlive-timestamp",
} as const;

/** Headers that authenticate one request to the worker of `vault` (the NEP-413 recipient). */
export function signRequest(opts: {
  accountId: string;
  signer: Signer;
  vault: string;
  method: string;
  path: string;
  body: Uint8Array | string;
  now?: number;
}): Record<string, string> {
  const timestamp = opts.now ?? Date.now();
  const nonce = randomBytes(NONCE_BYTES);
  const message = authMessage(opts.method, opts.path, sha256Hex(opts.body), timestamp);
  const signature = signPayload(opts.signer, { message, nonce, recipient: opts.vault });
  return {
    [AUTH_HEADERS.account]: opts.accountId,
    [AUTH_HEADERS.publicKey]: opts.signer.publicKey,
    [AUTH_HEADERS.signature]: toBase64(signature),
    [AUTH_HEADERS.nonce]: toBase64(nonce),
    [AUTH_HEADERS.timestamp]: String(timestamp),
  };
}

export interface ParsedAuth {
  accountId: string;
  publicKey: string;
  signature: Uint8Array;
  nonce: Uint8Array;
  timestamp: number;
}

/** Reads the auth headers. Returns an error string instead of throwing. */
export function parseAuthHeaders(headers: Record<string, string | string[] | undefined>): ParsedAuth | string {
  const get = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const accountId = get(AUTH_HEADERS.account);
  const publicKey = get(AUTH_HEADERS.publicKey);
  const sig = get(AUTH_HEADERS.signature);
  const nonce = get(AUTH_HEADERS.nonce);
  const ts = get(AUTH_HEADERS.timestamp);
  if (!accountId || !publicKey || !sig || !nonce || !ts) return "missing NEP-413 auth headers";
  if (!/^\d{1,16}$/.test(ts)) return "bad timestamp";
  try {
    const parsed = {
      accountId,
      publicKey,
      signature: fromBase64(sig),
      nonce: fromBase64(nonce),
      timestamp: Number(ts),
    };
    if (parsed.nonce.length !== NONCE_BYTES) return "nonce must be 32 bytes";
    return parsed;
  } catch {
    return "bad base64 in auth headers";
  }
}
