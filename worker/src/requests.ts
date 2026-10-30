// Validation of customer delivery requests.

import { ALLOWED_METHODS, MAX_BODY_BYTES, MAX_HEADERS, type DeliveryRequest } from "@deed/sdk";

export const MAX_URL_LENGTH = 2048;
export const MAX_IDEMPOTENCY_KEY = 128;

// Headers a customer may not set: they belong to the connection or to the relay signature.
const FORBIDDEN_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "expect",
]);

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

export function validateRequest(input: unknown): DeliveryRequest | string {
  if (!input || typeof input !== "object") return "body must be a JSON object";
  const r = input as Record<string, unknown>;
  if (typeof r.url !== "string" || r.url.length === 0 || r.url.length > MAX_URL_LENGTH) return "url must be a string of at most 2048 characters";
  let url: URL;
  try {
    url = new URL(r.url);
  } catch {
    return "url is not valid";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "only http and https urls";
  const method = typeof r.method === "string" ? r.method.toUpperCase() : "POST";
  if (!(ALLOWED_METHODS as readonly string[]).includes(method)) return `method must be one of ${ALLOWED_METHODS.join(", ")}`;
  const headers: Record<string, string> = {};
  if (r.headers !== undefined) {
    if (!r.headers || typeof r.headers !== "object" || Array.isArray(r.headers)) return "headers must be an object";
    const entries = Object.entries(r.headers as Record<string, unknown>);
    if (entries.length > MAX_HEADERS) return `at most ${MAX_HEADERS} headers`;
    for (const [name, value] of entries) {
      if (!HEADER_NAME.test(name)) return `bad header name ${name}`;
      if (typeof value !== "string" || value.length > 4096 || /[\r\n\0]/.test(value)) return `bad value for header ${name}`;
      const lower = name.toLowerCase();
      if (FORBIDDEN_HEADERS.has(lower) || lower.startsWith("x-deed-")) return `header ${name} may not be set`;
      headers[lower] = value;
    }
  }
  const body = r.body === undefined ? "" : r.body;
  if (typeof body !== "string") return "body must be a string";
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return "body is larger than 64 KB";
  if (typeof r.idempotency_key !== "string" || r.idempotency_key.length === 0 || r.idempotency_key.length > MAX_IDEMPOTENCY_KEY) {
    return "idempotency_key must be a string of 1 to 128 characters";
  }
  return { url: r.url, method, headers, body, idempotency_key: r.idempotency_key };
}
