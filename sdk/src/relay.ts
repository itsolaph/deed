// Wire types of the webhook relay API served by a worker.

import type { DeliveryProof, ObligationReceipt, Signed } from "./receipts.js";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_HEADERS = 32;
export const ALLOWED_METHODS = ["POST", "PUT", "PATCH", "GET", "DELETE"] as const;

/** What a customer asks the relay to deliver. */
export interface DeliveryRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** UTF-8 body, at most 64 KB. */
  body: string;
  /** Same key, same delivery: retrying a POST never creates a second paid delivery. */
  idempotency_key: string;
}

export type DeliveryState = "pending" | "delivered" | "failed";

export interface AcceptedResponse {
  delivery_id: string;
  receipt: Signed<ObligationReceipt>;
}

export interface StatusResponse {
  delivery_id: string;
  state: DeliveryState;
  receipt: Signed<ObligationReceipt>;
  attempts: Signed<DeliveryProof>[];
  next_attempt_at: number | null;
}

/** A pending obligation, presented again to a new worker after a handover. */
export interface ObligationEntry {
  receipt: Signed<ObligationReceipt>;
  request: DeliveryRequest;
  /** Hand-off only: proofs of the old worker's attempts. A last proof with a 2xx status
   * means it was delivered and only the charge is still open. */
  attempts?: Signed<DeliveryProof>[];
}

export interface ObligationResult {
  delivery_id: string;
  /** accepted: taken over now; known: this worker already has it; rejected: see reason. */
  result: "accepted" | "known" | "rejected";
  reason?: string;
  /** true when the old seq was not charged on chain, so this worker charges it as new. */
  charged_as_new?: boolean;
  /** The receipt now in force (a new one when charged as new). */
  receipt?: Signed<ObligationReceipt>;
}

/** Sent by a worker that lost its key to the new endpoint, signed with the old worker key. */
export interface HandoffEnvelope {
  vault: string;
  from_public_key: string;
  created_at: number;
  entries: ObligationEntry[];
}

/** Body of HTTP 402: how to become a paying customer. */
export interface PaymentRequired {
  error: "payment_required";
  reason: "unknown_customer" | "insufficient_balance" | "daily_cap_reached" | "refund_pending";
  vault: string;
  payment_token: string;
  price_per_call: string;
  min_deposit: string;
  balance: string;
  how_to_pay: {
    contract: string;
    method: "ft_transfer_call";
    args: { receiver_id: string; amount: string; msg: string };
    attached_deposit: "1 yoctoNEAR";
    gas: string;
    near_cli: string;
  };
}

/** Body of HTTP 410: this worker no longer serves the vault. */
export interface Gone {
  error: "gone";
  vault: string;
  endpoint: string;
  worker_public_key: string | null;
}

export interface HealthResponse {
  ok: boolean;
  vault: string;
  worker_public_key: string;
  accepting: boolean;
  price_per_call: string;
  payment_token: string;
  queue: { pending: number; delivered: number; failed: number };
}
