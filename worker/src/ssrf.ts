// Outbound HTTP for deliveries, safe against server-side request forgery:
// - http and https only, no credentials in the URL;
// - DNS is resolved once and the connection goes to that pinned IP (no DNS rebinding);
// - every resolved address must be public: loopback, private, link-local, CGNAT, multicast,
//   unspecified, documentation, benchmark, metadata and the IPv6 equivalents, including
//   IPv4-mapped, IPv4-compatible and NAT64 forms, are refused;
// - every redirect hop is checked the same way (at most 3);
// - connect/response timeouts and a response size cap.
// One explicit `ip:port` may be allowed for local demos (`--allow-target`).

import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { createHash } from "node:crypto";

export const MAX_REDIRECTS = 3;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;

const BLOCKED_V4: [string, number, string][] = [
  ["0.0.0.0", 8, "unspecified"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "cgnat"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local or metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "ietf protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved or broadcast"],
];

const BLOCKED_V6: [string, number, string][] = [
  ["::", 128, "unspecified"],
  ["::1", 128, "loopback"],
  ["100::", 64, "discard"],
  ["2001::", 32, "teredo"],
  ["2001:db8::", 32, "documentation"],
  ["2002::", 16, "6to4"],
  ["fc00::", 7, "unique local (private)"],
  ["fe80::", 10, "link-local"],
  ["fec0::", 10, "site-local"],
  ["ff00::", 8, "multicast"],
];

function compile(ranges: [string, number, string][], type: "ipv4" | "ipv6"): [net.BlockList, string][] {
  return ranges.map(([addr, prefix, reason]) => {
    const list = new net.BlockList();
    list.addSubnet(addr, prefix, type);
    return [list, reason];
  });
}

const V4_RULES = compile(BLOCKED_V4, "ipv4");
const V6_RULES = compile(BLOCKED_V6, "ipv6");

function v4Reason(ip: string): string | null {
  for (const [list, reason] of V4_RULES) if (list.check(ip, "ipv4")) return reason;
  return null;
}

/** Expands an IPv6 address to 8 groups of 16 bits. Returns null if it is not IPv6. */
function ipv6Groups(ip: string): number[] | null {
  if (!net.isIPv6(ip)) return null;
  let text = ip.split("%")[0] ?? "";
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups.
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    const parts = dotted[1].split(".").map(Number);
    const [a = 0, b = 0, c = 0, d = 0] = parts;
    text = text.slice(0, -dotted[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head = "", tail] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...(tail !== undefined ? Array(missing).fill("0") : []), ...tailGroups];
  if (groups.length !== 8) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v4FromGroups(hi: number, lo: number): string {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join(".");
}

/** Returns why `ip` must not be contacted, or null if it is a public address. */
export function blockedReason(ip: string): string | null {
  if (net.isIPv4(ip)) return v4Reason(ip);
  const g = ipv6Groups(ip);
  if (!g) return "not an IP address";
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const embedded = v4FromGroups(g6, g7);
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d: judge the embedded IPv4.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return g7 === 0 ? "unspecified" : "loopback";
    const r = v4Reason(embedded);
    return r ? `${r} (IPv4 in IPv6)` : null;
  }
  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48 carry an IPv4 address in the last 32 bits.
  if (g0 === 0x64 && g1 === 0xff9b) {
    const r = v4Reason(embedded);
    return r ? `${r} (NAT64)` : null;
  }
  for (const [list, reason] of V6_RULES) if (list.check(ip, "ipv6")) return reason;
  return null;
}

export class BlockedTargetError extends Error {}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
  port: number;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

export interface TargetPolicy {
  /** Exactly one "ip:port" that may be contacted even if it is not public. Demo use only. */
  allowTarget?: string | undefined;
  resolver?: Resolver;
}

function defaultPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** Validates the URL, resolves it once and checks every address. */
export async function resolveTarget(raw: string, policy: TargetPolicy = {}): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedTargetError("not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedTargetError("only http and https targets");
  if (url.username || url.password) throw new BlockedTargetError("credentials in the URL are not allowed");
  const port = defaultPort(url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const resolver = policy.resolver ?? systemResolver;
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIPv6(host) ? 6 : 4 }] : await resolver(host);
  if (addresses.length === 0) throw new BlockedTargetError("host did not resolve");
  for (const a of addresses) {
    const allowed = policy.allowTarget !== undefined && policy.allowTarget === `${a.address}:${port}`;
    const reason = allowed ? null : blockedReason(a.address);
    if (reason) throw new BlockedTargetError(`target resolves to a blocked address (${reason})`);
  }
  const first = addresses[0]!;
  return { url, address: first.address, family: first.family === 6 ? 6 : 4, port };
}

export interface OutboundRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface OutboundResult {
  status: number;
  responseSha256: string;
  bytes: number;
  truncated: boolean;
  finalUrl: string;
  redirects: number;
}

export interface SendOptions extends TargetPolicy {
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Called before each hop to get headers that depend on the final URL (relay signature). */
  signHop?: (hop: { url: URL; method: string; body: string }) => Record<string, string>;
}

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

function sendOnce(target: ResolvedTarget, req: OutboundRequest, opts: SendOptions): Promise<{ status: number; location?: string; sha256: string; bytes: number; truncated: boolean }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const lib = target.url.protocol === "https:" ? https : http;
  const body = Buffer.from(req.body, "utf8");
  return new Promise((resolve, reject) => {
    const r = lib.request(
      {
        host: target.url.hostname.replace(/^\[|\]$/g, ""),
        port: target.port,
        path: target.url.pathname + target.url.search,
        method: req.method,
        headers: { ...req.headers, host: target.url.host, "content-length": String(body.length) },
        // Connect to the address that was checked, never to a fresh DNS answer.
        lookup: (_hostname, options, cb) => {
          if (typeof options === "object" && options && (options as { all?: boolean }).all) {
            (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address: target.address, family: target.family }]);
          } else {
            cb(null, target.address, target.family);
          }
        },
        servername: target.url.hostname,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const hash = createHash("sha256");
        let bytes = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          const room = maxBytes - bytes;
          if (chunk.length > room) {
            hash.update(chunk.subarray(0, room));
            bytes += room;
            truncated = true;
            res.destroy();
            finish();
            return;
          }
          hash.update(chunk);
          bytes += chunk.length;
        });
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
          resolve({ status: res.statusCode ?? 0, ...(location ? { location } : {}), sha256: hash.digest("hex"), bytes, truncated });
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", (e) => (done ? undefined : reject(e)));
      },
    );
    const timer = setTimeout(() => r.destroy(new Error("timeout")), timeoutMs);
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    r.on("close", () => clearTimeout(timer));
    r.end(body);
  });
}

/** Sends a request, following up to 3 redirects, each hop checked like the first. */
export async function safeSend(req: OutboundRequest, opts: SendOptions = {}): Promise<OutboundResult> {
  let current: OutboundRequest = req;
  for (let hop = 0; ; hop++) {
    const target = await resolveTarget(current.url, opts);
    const extra = opts.signHop?.({ url: target.url, method: current.method, body: current.body }) ?? {};
    const res = await sendOnce(target, { ...current, headers: { ...current.headers, ...extra } }, opts);
    if (REDIRECT_CODES.has(res.status) && res.location) {
      if (hop >= MAX_REDIRECTS) throw new BlockedTargetError("too many redirects");
      const next = new URL(res.location, target.url).toString();
      const keepMethod = res.status === 307 || res.status === 308;
      current = keepMethod ? { ...current, url: next } : { ...current, url: next, method: "GET", body: "" };
      continue;
    }
    return {
      status: res.status,
      responseSha256: res.sha256,
      bytes: res.bytes,
      truncated: res.truncated,
      finalUrl: target.url.toString(),
      redirects: hop,
    };
  }
}
