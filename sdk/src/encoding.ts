// Byte helpers shared by the SDK, the worker and the web app. Browser-safe (no node: imports).

import { sha256 } from "@noble/hashes/sha2.js";
import { base58, base64 } from "@scure/base";

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return sha256(typeof data === "string" ? utf8(data) : data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256Bytes(data));
}

export function toBase64(bytes: Uint8Array): string {
  return base64.encode(bytes);
}

export function fromBase64(text: string): Uint8Array {
  return base64.decode(text);
}

export function toBase58(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

export function fromBase58(text: string): Uint8Array {
  return base58.decode(text);
}

/**
 * JSON with object keys sorted at every level and no whitespace. Signatures are made over this
 * form so that both sides serialize a receipt the same way.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    if (typeof value === "bigint") throw new Error("bigint must be a string");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
