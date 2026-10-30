// Documents signed by a worker key: obligation receipts, delivery proofs, outbound request
// signatures and hand-off envelopes. Each kind has its own domain prefix so a signature for
// one kind can never be replayed as another.

import { canonicalJson, fromBase64, toBase64, utf8 } from "./encoding.js";
import { Signer, verifySignature } from "./keys.js";

export const RECEIPT_DOMAIN = "deed-obligation:v1\n";
export const PROOF_DOMAIN = "deed-delivery-proof:v1\n";
export const OUTBOUND_DOMAIN = "deed-relay-request:v1\n";
export const HANDOFF_DOMAIN = "deed-handoff:v1\n";

/** What the worker promises when it accepts a paid delivery. */
export interface ObligationReceipt {
  delivery_id: string;
  vault: string;
  customer: string;
  /** Charge sequence number for this customer on the vault. */
  seq: number;
  /** Price per call (payment token units) at acceptance. */
  price: string;
  target_url_sha256: string;
  body_sha256: string;
  accepted_at: number;
  worker_public_key: string;
}

/** One delivery attempt, signed by the worker that made it. */
export interface DeliveryProof {
  delivery_id: string;
  vault: string;
  attempt: number;
  /** HTTP status code, or 0 if no response arrived (timeout, connection error, blocked). */
  status_code: number;
  response_sha256: string;
  error?: string;
  at: number;
  worker_public_key: string;
}

export interface Signed<T> {
  payload: T;
  /** base64 ed25519 signature over domain + canonical JSON of payload. */
  signature: string;
}

function signedBytes(domain: string, payload: unknown): Uint8Array {
  return utf8(domain + canonicalJson(payload));
}

export function signDocument<T>(domain: string, signer: Signer, payload: T): Signed<T> {
  return { payload, signature: toBase64(signer.sign(signedBytes(domain, payload))) };
}

export function verifyDocument<T>(domain: string, doc: Signed<T>, publicKey: string): boolean {
  try {
    return verifySignature(publicKey, signedBytes(domain, doc.payload), fromBase64(doc.signature));
  } catch {
    return false;
  }
}

export function signReceipt(signer: Signer, r: ObligationReceipt): Signed<ObligationReceipt> {
  if (r.worker_public_key !== signer.publicKey) throw new Error("receipt names a different worker key");
  return signDocument(RECEIPT_DOMAIN, signer, r);
}

/** Checks the signature against the key the receipt names. Whether that key belonged to the
 * vault is a separate check (see `verifyReceiptForVault` in the client). */
export function verifyReceipt(doc: Signed<ObligationReceipt>): boolean {
  return verifyDocument(RECEIPT_DOMAIN, doc, doc.payload.worker_public_key);
}

export function signProof(signer: Signer, p: DeliveryProof): Signed<DeliveryProof> {
  if (p.worker_public_key !== signer.publicKey) throw new Error("proof names a different worker key");
  return signDocument(PROOF_DOMAIN, signer, p);
}

export function verifyProof(doc: Signed<DeliveryProof>): boolean {
  return verifyDocument(PROOF_DOMAIN, doc, doc.payload.worker_public_key);
}

export const OUTBOUND_HEADERS = {
  vault: "x-deed-relay-vault",
  deliveryId: "x-deed-delivery-id",
  attempt: "x-deed-attempt",
  timestamp: "x-deed-relay-timestamp",
  key: "x-deed-relay-key",
  signature: "x-deed-relay-signature",
} as const;

export function outboundMessage(fields: {
  vault: string;
  deliveryId: string;
  attempt: number;
  timestamp: number;
  method: string;
  /** Path and query of the target URL, as the target sees it. */
  path: string;
  bodySha256: string;
}): Uint8Array {
  return utf8(
    OUTBOUND_DOMAIN +
      [fields.vault, fields.deliveryId, fields.attempt, fields.timestamp, fields.method.toUpperCase(), fields.path, fields.bodySha256].join("\n"),
  );
}

/** Headers a worker adds to every outbound request so the target can check the relay. */
export function signOutbound(
  signer: Signer,
  fields: Parameters<typeof outboundMessage>[0],
): Record<string, string> {
  return {
    [OUTBOUND_HEADERS.vault]: fields.vault,
    [OUTBOUND_HEADERS.deliveryId]: fields.deliveryId,
    [OUTBOUND_HEADERS.attempt]: String(fields.attempt),
    [OUTBOUND_HEADERS.timestamp]: String(fields.timestamp),
    [OUTBOUND_HEADERS.key]: signer.publicKey,
    [OUTBOUND_HEADERS.signature]: toBase64(signer.sign(outboundMessage(fields))),
  };
}

/** Target side: checks the relay signature. The caller must also check that the key is a
 * worker key of the vault (see the vault's `get_worker_history`). */
export function verifyOutbound(
  headers: Record<string, string | string[] | undefined>,
  request: { method: string; path: string; bodySha256: string },
): { ok: boolean; vault?: string; key?: string; deliveryId?: string } {
  const get = (name: string) => {
    const v = headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  const vault = get(OUTBOUND_HEADERS.vault);
  const deliveryId = get(OUTBOUND_HEADERS.deliveryId);
  const attempt = Number(get(OUTBOUND_HEADERS.attempt));
  const timestamp = Number(get(OUTBOUND_HEADERS.timestamp));
  const key = get(OUTBOUND_HEADERS.key);
  const sig = get(OUTBOUND_HEADERS.signature);
  if (!vault || !deliveryId || !key || !sig || !Number.isFinite(attempt) || !Number.isFinite(timestamp)) {
    return { ok: false };
  }
  let signature: Uint8Array;
  try {
    signature = fromBase64(sig);
  } catch {
    return { ok: false };
  }
  const msg = outboundMessage({ vault, deliveryId, attempt, timestamp, ...request });
  return { ok: verifySignature(key, msg, signature), vault, key, deliveryId };
}
