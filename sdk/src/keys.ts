// ed25519 keys in NEAR's string format ("ed25519:<base58>"). Browser-safe.

import { ed25519 } from "@noble/curves/ed25519.js";
import { fromBase58, toBase58 } from "./encoding.js";

const PREFIX = "ed25519:";

export interface Signer {
  /** NEAR public key string, for example "ed25519:8hS...". */
  readonly publicKey: string;
  sign(message: Uint8Array): Uint8Array;
}

export function parsePublicKey(key: string): Uint8Array {
  if (!key.startsWith(PREFIX)) throw new Error("only ed25519 keys are supported");
  const bytes = fromBase58(key.slice(PREFIX.length));
  if (bytes.length !== 32) throw new Error("bad ed25519 public key length");
  return bytes;
}

export function formatPublicKey(bytes: Uint8Array): string {
  return PREFIX + toBase58(bytes);
}

/**
 * Builds a signer from a NEAR secret key string. NEAR stores ed25519 secret keys as 64 bytes:
 * the 32-byte seed followed by the public key. The key never leaves this object.
 */
export function signerFromSecretKey(secretKey: string): Signer {
  if (!secretKey.startsWith(PREFIX)) throw new Error("only ed25519 keys are supported");
  const raw = fromBase58(secretKey.slice(PREFIX.length));
  if (raw.length !== 64 && raw.length !== 32) throw new Error("bad ed25519 secret key length");
  const seed = raw.slice(0, 32);
  const publicKey = formatPublicKey(ed25519.getPublicKey(seed));
  return {
    publicKey,
    sign: (message) => ed25519.sign(message, seed),
  };
}

export function generateSecretKey(): { secretKey: string; publicKey: string } {
  const seed = ed25519.utils.randomSecretKey();
  const pub = ed25519.getPublicKey(seed);
  const full = new Uint8Array(64);
  full.set(seed, 0);
  full.set(pub, 32);
  return { secretKey: PREFIX + toBase58(full), publicKey: formatPublicKey(pub) };
}

export function verifySignature(publicKey: string, message: Uint8Array, signature: Uint8Array): boolean {
  try {
    return ed25519.verify(signature, message, parsePublicKey(publicKey));
  } catch {
    return false;
  }
}
