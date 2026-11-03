// DeedClient: the customer side of a Deed relay. Browser-safe apart from the optional
// transactor (see node.ts), which signs on-chain top-ups.

import { Rpc } from "./chain.js";
import { sha256Hex } from "./encoding.js";
import { Signer } from "./keys.js";
import { signRequest } from "./nep413.js";
import { ObligationReceipt, Signed, verifyProof, verifyReceipt } from "./receipts.js";
import type {
  AcceptedResponse,
  DeliveryRequest,
  Gone,
  ObligationEntry,
  ObligationResult,
  PaymentRequired,
  StatusResponse,
} from "./relay.js";
import { VaultViews } from "./views.js";

/** Sends one function-call transaction as the customer. Returns the tx hash and outcome. */
export type Transactor = (call: {
  contractId: string;
  method: string;
  args: Record<string, unknown>;
  gasTgas: number;
  depositYocto: bigint;
}) => Promise<{ hash: string; success: boolean; error?: string }>;

export class PaymentRequiredError extends Error {
  constructor(readonly details: PaymentRequired) {
    super(`payment required: ${details.reason}`);
  }
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

export interface DeedClientOptions {
  vault: string;
  accountId: string;
  signer: Signer;
  rpc?: Rpc;
  /** Replaces the chain reads (tests). */
  views?: VaultReader;
  transactor?: Transactor;
  /** Overrides the endpoint from chain (tests). */
  endpoint?: string;
  /** How long a worker key history read is reused. */
  keyCacheMs?: number;
  fetchImpl?: typeof fetch;
  /** Called on handovers, re-presentations and other notable events. */
  onEvent?: (event: string, detail: Record<string, unknown>) => void;
  /** Keeps the open obligations (receipt + request) outside the process, so a customer that
   * restarts can still resubmit them (see `fileStore` in the Node entry point). */
  store?: PendingStore;
}

/** Where a client keeps its open obligations between runs. */
export interface PendingStore {
  load(): ObligationEntry[];
  save(entries: ObligationEntry[]): void;
}

export type VaultReader = Pick<VaultViews, "info" | "workerHistory" | "customer">;

interface Pending {
  entry: ObligationEntry;
  lastState?: string;
}

const DEFAULT_KEY_CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

export class DeedClient {
  readonly vault: string;
  readonly accountId: string;
  private readonly signer: Signer;
  private readonly views: VaultReader;
  private readonly transactor: Transactor | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly keyCacheMs: number;
  private readonly onEvent: NonNullable<DeedClientOptions["onEvent"]>;
  private endpoint: string | undefined;
  private readonly endpointOverride: boolean;
  private keys: { at: number; keys: Set<string> } | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly store: PendingStore | undefined;
  private readonly rejected = new Map<string, { entry: ObligationEntry; reason: string }>();

  constructor(opts: DeedClientOptions) {
    this.vault = opts.vault;
    this.accountId = opts.accountId;
    this.signer = opts.signer;
    this.views = opts.views ?? new VaultViews(opts.rpc ?? new Rpc(), opts.vault);
    this.transactor = opts.transactor;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.keyCacheMs = opts.keyCacheMs ?? DEFAULT_KEY_CACHE_MS;
    this.onEvent = opts.onEvent ?? (() => {});
    this.endpoint = opts.endpoint;
    this.endpointOverride = opts.endpoint !== undefined;
    this.store = opts.store;
    // Receipts kept by an earlier run are open obligations again; they are checked when presented.
    for (const entry of this.store?.load() ?? []) {
      const id = entry?.receipt?.payload?.delivery_id;
      if (typeof id === "string" && entry.receipt.payload.vault === this.vault && entry.receipt.payload.customer === this.accountId) this.pending.set(id, { entry });
    }
  }

  private persist(): void {
    this.store?.save(this.pendingEntries());
  }

  /** The worker endpoint as published in the vault (`set_config`). */
  async resolveEndpoint(force = false): Promise<string> {
    if (this.endpoint && (!force || this.endpointOverride)) return this.endpoint;
    const info = await this.views.info();
    const next = info.endpoint.replace(/\/+$/, "");
    if (this.endpoint && next !== this.endpoint) this.onEvent("endpoint_changed", { from: this.endpoint, to: next });
    this.endpoint = next;
    return next;
  }

  /** Worker keys this vault has registered (current and recent), cached briefly. */
  async workerKeys(force = false): Promise<Set<string>> {
    if (!force && this.keys && Date.now() - this.keys.at < this.keyCacheMs) return this.keys.keys;
    const [info, history] = await Promise.all([this.views.info(), this.views.workerHistory()]);
    const keys = new Set(history.map((h) => h.public_key));
    if (info.worker_key) keys.add(info.worker_key);
    this.keys = { at: Date.now(), keys };
    return keys;
  }

  /** A receipt is valid if its signature checks out, it names this vault and customer, and
   * it was signed by a key the vault registered as its worker. */
  async verifyReceiptForVault(doc: Signed<ObligationReceipt>, request?: DeliveryRequest): Promise<string | null> {
    const r = doc.payload;
    if (r.vault !== this.vault) return "receipt names another vault";
    if (r.customer !== this.accountId) return "receipt names another customer";
    if (!verifyReceipt(doc)) return "bad receipt signature";
    if (request) {
      if (r.target_url_sha256 !== sha256Hex(request.url)) return "receipt target hash does not match";
      if (r.body_sha256 !== sha256Hex(request.body)) return "receipt body hash does not match";
    }
    let keys = await this.workerKeys();
    if (!keys.has(r.worker_public_key)) keys = await this.workerKeys(true);
    if (!keys.has(r.worker_public_key)) return "receipt key was never a worker key of this vault";
    return null;
  }

  private async send(method: string, path: string, body: unknown, attempt = 0): Promise<{ status: number; json: unknown }> {
    const endpoint = await this.resolveEndpoint(attempt > 0);
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      ...signRequest({ accountId: this.accountId, signer: this.signer, vault: this.vault, method, path, body: text }),
    };
    if (text) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(endpoint + path, {
        method,
        headers,
        ...(text ? { body: text } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // The worker may have moved: read the endpoint from chain again and retry once.
      if (attempt === 0) {
        this.onEvent("connection_failed", { endpoint, error: String(e) });
        const next = await this.resolveEndpoint(true);
        if (next !== endpoint) await this.represent().catch((err) => this.onEvent("represent_failed", { error: String(err) }));
        return this.send(method, path, body, 1);
      }
      throw e;
    }
    const json = await res.json().catch(() => null);
    if (res.status === 410 && attempt === 0) {
      const gone = json as Gone;
      this.onEvent("worker_gone", { endpoint, next: gone?.endpoint });
      this.endpoint = undefined;
      await this.resolveEndpoint(true);
      await this.represent().catch((e) => this.onEvent("represent_failed", { error: String(e) }));
      return this.send(method, path, body, 1);
    }
    return { status: res.status, json };
  }

  /** Asks the relay to deliver `request`. Resolves with the verified obligation receipt. */
  async deliver(request: DeliveryRequest): Promise<AcceptedResponse> {
    const { status, json } = await this.send("POST", "/v1/deliveries", request);
    if (status === 402) throw new PaymentRequiredError(json as PaymentRequired);
    if (status !== 202 && status !== 200) throw new RelayError(`delivery refused (${status})`, status, json);
    const accepted = json as AcceptedResponse;
    const problem = await this.verifyReceiptForVault(accepted.receipt, request);
    if (problem) throw new RelayError(`invalid receipt: ${problem}`, status, json);
    this.pending.set(accepted.delivery_id, { entry: { receipt: accepted.receipt, request } });
    this.persist();
    return accepted;
  }

  /** Status of one delivery with every attempt proof checked. */
  async status(deliveryId: string): Promise<StatusResponse> {
    const { status, json } = await this.send("GET", `/v1/deliveries/${encodeURIComponent(deliveryId)}`, undefined);
    if (status !== 200) throw new RelayError(`status failed (${status})`, status, json);
    const s = json as StatusResponse;
    const keys = await this.workerKeys();
    for (const proof of s.attempts) {
      if (proof.payload.delivery_id !== deliveryId || proof.payload.vault !== this.vault) {
        throw new RelayError("proof for another delivery", status, json);
      }
      if (!verifyProof(proof)) throw new RelayError("bad delivery proof signature", status, json);
      if (!keys.has(proof.payload.worker_public_key) && !(await this.workerKeys(true)).has(proof.payload.worker_public_key)) {
        throw new RelayError("proof key was never a worker key of this vault", status, json);
      }
    }
    return s;
  }

  /** Re-presents every obligation not yet confirmed delivered to the current worker. */
  async represent(): Promise<ObligationResult[]> {
    return this.representIds([...this.pending.keys()]);
  }

  private async representIds(ids: string[]): Promise<ObligationResult[]> {
    const entries = ids.map((id) => this.pending.get(id)?.entry).filter((e): e is ObligationEntry => e !== undefined);
    if (entries.length === 0) return [];
    const { status, json } = await this.send("POST", "/v1/obligations", { entries }, 1);
    if (status !== 200) throw new RelayError(`re-presenting failed (${status})`, status, json);
    const results = (json as { results: ObligationResult[] }).results;
    for (const r of results) {
      const p = this.pending.get(r.delivery_id);
      // Refused for good (refund pending, unpaid, bad receipt): stop presenting it. A failed
      // chain read on the worker's side is not final, so that one stays pending.
      if (p && r.result === "rejected" && !/^chain read failed/.test(r.reason ?? "")) {
        this.pending.delete(r.delivery_id);
        this.rejected.set(r.delivery_id, { entry: p.entry, reason: r.reason ?? "rejected" });
        continue;
      }
      if (p && r.receipt) {
        const problem = await this.verifyReceiptForVault(r.receipt, p.entry.request);
        if (!problem) p.entry = { ...p.entry, receipt: r.receipt };
      }
    }
    this.persist();
    this.onEvent("represented", {
      count: entries.length,
      accepted: results.filter((r) => r.result === "accepted").length,
      known: results.filter((r) => r.result === "known").length,
      charged_as_new: results.filter((r) => r.charged_as_new).length,
    });
    return results;
  }

  /**
   * Polls every pending obligation once and forgets the finished ones. A receipt the current
   * worker does not know (it came from an earlier worker that is gone) is presented to it
   * again. Delivery is at least once: if the earlier worker delivered it but the client never
   * saw the proof, the target may get it twice. It is never charged twice.
   */
  async track(): Promise<{ delivered: string[]; failed: string[]; pending: number }> {
    const delivered: string[] = [];
    const failed: string[] = [];
    const unknown: string[] = [];
    for (const [id, p] of [...this.pending]) {
      try {
        const s = await this.status(id);
        p.lastState = s.state;
        if (s.state === "delivered") delivered.push(id);
        if (s.state === "failed") failed.push(id);
        if (s.state !== "pending") this.pending.delete(id);
      } catch (e) {
        if (e instanceof RelayError && e.status === 404) {
          p.lastState = "unknown";
          unknown.push(id);
          continue;
        }
        throw e;
      }
    }
    if (delivered.length + failed.length > 0) this.persist();
    if (unknown.length > 0) await this.representIds(unknown);
    return { delivered, failed, pending: this.pending.size };
  }

  /**
   * Takes over obligations this client did not create in this process: receipts saved by an
   * earlier run, or copied from another machine. Each receipt must name this vault and customer,
   * carry a valid signature by a key the vault registered as a worker key (current or earlier),
   * and match its request. Valid ones become pending; `resubmit` presents them.
   */
  async adopt(entries: ObligationEntry[]): Promise<{ adopted: string[]; rejected: { delivery_id: string; reason: string }[] }> {
    const adopted: string[] = [];
    const rejected: { delivery_id: string; reason: string }[] = [];
    for (const entry of entries) {
      const id = String(entry?.receipt?.payload?.delivery_id ?? "");
      const problem = entry?.receipt?.payload ? await this.verifyReceiptForVault(entry.receipt, entry.request) : "no receipt";
      if (problem) {
        rejected.push({ delivery_id: id, reason: problem });
        continue;
      }
      if (!this.pending.has(id)) this.pending.set(id, { entry: { receipt: entry.receipt, request: entry.request } });
      adopted.push(id);
    }
    this.persist();
    return { adopted, rejected };
  }

  /**
   * Presents every open obligation (optionally adopting `entries` first) to the worker at the
   * endpoint the vault publishes on chain now. Use after the old worker vanished without a
   * hand-off: the current worker delivers receipts already charged on chain without charging
   * again, and charges the others once, as new.
   */
  async resubmit(entries: ObligationEntry[] = []): Promise<ObligationResult[]> {
    if (entries.length > 0) await this.adopt(entries);
    await this.resolveEndpoint(true);
    return this.represent();
  }

  /** Starts the vault's refund delay for this customer's whole unspent credit. Needs a transactor. */
  async requestRefund(): Promise<{ hash: string; success: boolean; error?: string }> {
    if (!this.transactor) throw new Error("requestRefund needs a transactor (see createNodeTransactor)");
    return this.transactor({ contractId: this.vault, method: "request_refund", args: {}, gasTgas: 30, depositYocto: 0n });
  }

  /** Pays the unspent credit back once the refund delay has passed. Needs a transactor. */
  async claimRefund(): Promise<{ hash: string; success: boolean; error?: string }> {
    if (!this.transactor) throw new Error("claimRefund needs a transactor (see createNodeTransactor)");
    return this.transactor({ contractId: this.vault, method: "claim_refund", args: {}, gasTgas: 60, depositYocto: 0n });
  }

  pendingCount(): number {
    return this.pending.size;
  }

  pendingEntries(): ObligationEntry[] {
    return [...this.pending.values()].map((p) => p.entry);
  }

  /** Obligations the current worker refused for good when they were presented, with its reason. */
  rejectedEntries(): { entry: ObligationEntry; reason: string }[] {
    return [...this.rejected.values()];
  }

  /** Adds credit with `ft_transfer_call` on the payment token. Needs a transactor. */
  async topUp(amount: bigint, forAccount?: string): Promise<{ hash: string; success: boolean; error?: string }> {
    if (!this.transactor) throw new Error("topUp needs a transactor (see createNodeTransactor)");
    const info = await this.views.info();
    const msg = forAccount && forAccount !== this.accountId ? JSON.stringify({ deposit_for: forAccount }) : "";
    return this.transactor({
      contractId: info.payment_token,
      method: "ft_transfer_call",
      args: { receiver_id: this.vault, amount: amount.toString(), msg },
      gasTgas: 60,
      depositYocto: 1n,
    });
  }

  /** Customer view of this account in the vault ledger. */
  customer() {
    return this.views.customer(this.accountId);
  }
}
