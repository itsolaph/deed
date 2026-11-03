// The worker: accepts paid deliveries, delivers them with retries, charges the vault and
// hands its queue over when the deed's new owner registers another worker key.

import {
  HANDOFF_DOMAIN,
  canonicalJson,
  randomBytes,
  sha256Hex,
  signDocument,
  signOutbound,
  signProof,
  signReceipt,
  toHex,
  verifyDocument,
  verifyProof,
  verifyReceipt,
  type DeliveryProof,
  type DeliveryRequest,
  type DeliveryState,
  type HandoffEnvelope,
  type ObligationEntry,
  type ObligationReceipt,
  type ObligationResult,
  type PaymentRequired,
  type Signed,
  type Signer,
  type StatusResponse,
  type VaultInfo,
} from "@deed/sdk";
import { Charger, type PendingCharge, type RefusalReason } from "./charger.js";
import { Journal } from "./journal.js";
import { validateRequest } from "./requests.js";
import { classify, nextAttemptAt } from "./retry.js";
import { BlockedTargetError, resolveTarget, safeSend, type Resolver } from "./ssrf.js";
import type { VaultChain } from "./vault-chain.js";

export interface WorkerConfig {
  vault: string;
  network: string;
  chain: VaultChain;
  signer: Signer;
  journalFile: string | null;
  /** URL this worker is reachable at, so it never hands its queue to itself. */
  publicUrl: string;
  allowTarget?: string | undefined;
  resolver?: Resolver;
  retrySchedule?: number[];
  hourlyMs?: number;
  flushIntervalMs?: number;
  watchIntervalMs?: number;
  concurrency?: number;
  timeoutMs?: number;
  handoff?: boolean;
  handoffAttempts?: number;
  handoffDelayMs?: number;
  log?: (line: string) => void;
  /** Called once the worker has stopped after a handover. */
  onRetired?: () => void;
  now?: () => number;
}

interface Delivery {
  id: string;
  customer: string;
  request: DeliveryRequest;
  receipt: Signed<ObligationReceipt>;
  state: DeliveryState;
  attempts: Signed<DeliveryProof>[];
  nextAttemptAt: number | null;
  running: boolean;
  /** Whether this worker charges it (false for obligations already charged by an earlier worker). */
  charge: boolean;
  chargeStatus?: string;
}

export type HttpReply = { status: number; body: unknown };

function summarizeResults(results: ObligationResult[]): string {
  const count = (f: (r: ObligationResult) => boolean) => results.filter(f).length;
  return (
    `${count((r) => r.result === "accepted")} taken over (${count((r) => r.charged_as_new === true)} charged as new), ` +
    `${count((r) => r.result === "known")} already here, ${count((r) => r.result === "rejected")} rejected`
  );
}

const ENGINE_TICK_MS = 200;
const HISTORY_CACHE_MS = 15_000;

export class Worker {
  readonly vault: string;
  readonly publicKey: string;
  private readonly chain: VaultChain;
  private readonly signer: Signer;
  private readonly journal: Journal;
  private readonly charger: Charger;
  private readonly cfg: WorkerConfig;
  private readonly log: (line: string) => void;
  private readonly now: () => number;
  private readonly deliveries = new Map<string, Delivery>();
  private readonly idempotency = new Map<string, string>();
  /** Admissions still waiting on the charger, by customer + idempotency key. A client that times
   * out and retries while the first request waits on a chain read gets the same delivery, not a
   * second one (seen on testnet under a slow RPC: one job charged twice). */
  private readonly admitting = new Map<string, Promise<HttpReply>>();
  private info: VaultInfo | null = null;
  private history: { at: number; keys: Set<string> } | null = null;
  private timers: NodeJS.Timeout[] = [];
  private running = 0;
  private gone: { endpoint: string; worker_key: string | null } | null = null;
  private retiring: Promise<void> | null = null;
  lastChargeTx: string | undefined;

  constructor(cfg: WorkerConfig) {
    this.cfg = cfg;
    this.vault = cfg.vault;
    this.chain = cfg.chain;
    this.signer = cfg.signer;
    this.publicKey = cfg.signer.publicKey;
    this.log = cfg.log ?? ((l) => console.log(l));
    this.now = cfg.now ?? Date.now;
    this.journal = new Journal(cfg.journalFile);
    this.charger = new Charger(
      cfg.chain,
      {
        onSettled: (item, status, tx) => this.onChargeSettled(item, status, tx),
        onReseq: (item) => this.reissueReceipt(item),
        onFloor: (customer, seq) => this.journal.append({ t: "floor", customer, seq }),
        onBatchFailed: (error) => {
          this.log(`charge batch failed: ${error}`);
          if (/worker key|AccessKeyDoesNotExist|does not exist|not the registered/i.test(error)) void this.watch();
        },
        log: this.log,
      },
      this.now,
    );
  }

  // ---------------------------------------------------------------- lifecycle

  /** Reads the vault and checks that this worker's key is the registered worker key. */
  async checkKey(): Promise<VaultInfo> {
    const info = await this.chain.info();
    this.info = info;
    if (info.worker_key !== this.publicKey) {
      throw new Error(`key mismatch: vault ${this.vault} has worker key ${info.worker_key ?? "(none)"}, this worker has ${this.publicKey}`);
    }
    return info;
  }

  async start(): Promise<void> {
    await this.checkKey();
    this.replay();
    const tick = (ms: number, fn: () => unknown) => {
      const t = setInterval(() => {
        Promise.resolve()
          .then(fn)
          .catch((e) => this.log(`background task failed: ${e instanceof Error ? e.message : String(e)}`));
      }, ms);
      t.unref?.();
      this.timers.push(t);
    };
    tick(ENGINE_TICK_MS, () => this.runDue());
    tick(this.cfg.flushIntervalMs ?? 4000, () => this.charger.flush());
    tick(this.cfg.watchIntervalMs ?? 3000, () => this.watch());
    tick(10_000, () => this.charger.refreshAll());
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.journal.close();
  }

  get accepting(): boolean {
    return this.gone === null;
  }

  private price(): bigint {
    const info = this.info!;
    let price = BigInt(info.price_per_call);
    // A price increase that lands soon: reserve at the new price already.
    if (info.pending_price !== null && info.price_effective_at_ms !== null && Number(info.price_effective_at_ms) - this.now() < 120_000) {
      const pending = BigInt(info.pending_price);
      if (pending > price) price = pending;
    }
    return price;
  }

  /** Rebuilds the queue from the journal. */
  private replay(): void {
    const records = this.journal.load();
    const charged = new Map<string, string>();
    const floors = new Map<string, number>();
    for (const r of records) {
      switch (r.t) {
        case "accepted":
          this.addDelivery({ id: r.id, customer: r.receipt.payload.customer, request: r.request, receipt: r.receipt, state: "pending", attempts: [], nextAttemptAt: this.now(), running: false, charge: r.charge });
          break;
        case "attempt": {
          const d = this.deliveries.get(r.id);
          if (d) {
            d.attempts.push(r.proof);
            d.nextAttemptAt = r.next_attempt_at;
          }
          break;
        }
        case "state": {
          const d = this.deliveries.get(r.id);
          if (d) d.state = r.state;
          break;
        }
        case "reseq": {
          const d = this.deliveries.get(r.id);
          if (d) d.receipt = r.receipt;
          break;
        }
        case "charged":
          charged.set(r.id, r.status);
          break;
        case "floor":
          if (!floors.has(r.customer)) floors.set(r.customer, r.seq);
          break;
      }
    }
    const pendingByCustomer = new Map<string, PendingCharge[]>();
    const maxSeq = new Map<string, number>();
    for (const d of this.deliveries.values()) {
      if (d.state === "pending" && d.nextAttemptAt === null) d.nextAttemptAt = this.now();
      if (!d.charge) continue;
      const seq = d.receipt.payload.seq;
      maxSeq.set(d.customer, Math.max(maxSeq.get(d.customer) ?? 0, seq));
      const status = charged.get(d.id);
      if (status) {
        d.chargeStatus = status;
        continue;
      }
      // Not confirmed before the restart: charge again. The vault reports an already applied
      // seq as "duplicate", so nothing is charged twice.
      const list = pendingByCustomer.get(d.customer) ?? [];
      list.push({ id: d.id, customer: d.customer, seq, cost: BigInt(d.receipt.payload.price), receiptsRoot: sha256Hex(canonicalJson(d.receipt)), retries: 0 });
      pendingByCustomer.set(d.customer, list);
    }
    const customers = new Set([...floors.keys(), ...pendingByCustomer.keys(), ...maxSeq.keys()]);
    for (const c of customers) {
      this.charger.restore(c, {
        ...(floors.has(c) ? { floor: floors.get(c)! } : {}),
        ...(pendingByCustomer.has(c) ? { pending: pendingByCustomer.get(c)! } : {}),
        ...(maxSeq.has(c) ? { maxSeq: maxSeq.get(c)! } : {}),
      });
    }
    if (records.length > 0) this.log(`journal replayed: ${this.deliveries.size} deliveries, ${this.queueCounts().pending} pending`);
  }

  private addDelivery(d: Delivery): void {
    this.deliveries.set(d.id, d);
    this.idempotency.set(`${d.customer}\n${d.request.idempotency_key}`, d.id);
  }

  queueCounts(): { pending: number; delivered: number; failed: number } {
    const c = { pending: 0, delivered: 0, failed: 0 };
    for (const d of this.deliveries.values()) c[d.state] += 1;
    return c;
  }

  // ---------------------------------------------------------------- accepting

  private newReceipt(fields: { id: string; customer: string; seq: number; price: bigint; request: DeliveryRequest; acceptedAt: number }): Signed<ObligationReceipt> {
    return signReceipt(this.signer, {
      delivery_id: fields.id,
      vault: this.vault,
      customer: fields.customer,
      seq: fields.seq,
      price: fields.price.toString(),
      target_url_sha256: sha256Hex(fields.request.url),
      body_sha256: sha256Hex(fields.request.body),
      accepted_at: fields.acceptedAt,
      worker_public_key: this.publicKey,
    });
  }

  private paymentRequired(customer: string, reason: RefusalReason, balance: bigint): HttpReply {
    const info = this.info!;
    const amount = BigInt(info.min_deposit) > this.price() ? info.min_deposit : this.price().toString();
    const args = { receiver_id: this.vault, amount, msg: "" };
    const body: PaymentRequired = {
      error: "payment_required",
      reason,
      vault: this.vault,
      payment_token: info.payment_token,
      price_per_call: this.price().toString(),
      min_deposit: info.min_deposit,
      balance: balance.toString(),
      how_to_pay: {
        contract: info.payment_token,
        method: "ft_transfer_call",
        args,
        attached_deposit: "1 yoctoNEAR",
        gas: "60 Tgas",
        near_cli:
          `near contract call-function as-transaction ${info.payment_token} ft_transfer_call json-args '${JSON.stringify(args)}' ` +
          `prepaid-gas '60.0 Tgas' attached-deposit '1 yoctoNEAR' sign-as ${customer} network-config ${this.cfg.network} sign-with-legacy-keychain send`,
      },
    };
    return { status: 402, body };
  }

  private goneReply(): HttpReply {
    return { status: 410, body: { error: "gone", vault: this.vault, endpoint: this.gone!.endpoint, worker_public_key: this.gone!.worker_key } };
  }

  /** Checks the target before any money is involved; attempts check it again. */
  private async checkTarget(url: string): Promise<string | null> {
    try {
      await resolveTarget(url, { allowTarget: this.cfg.allowTarget, ...(this.cfg.resolver ? { resolver: this.cfg.resolver } : {}) });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  async deliver(customer: string, input: unknown): Promise<HttpReply> {
    if (this.gone) return this.goneReply();
    const request = validateRequest(input);
    if (typeof request === "string") return { status: 400, body: { error: request } };
    const idemKey = `${customer}\n${request.idempotency_key}`;
    const known = this.idempotency.get(idemKey);
    if (known) {
      const d = this.deliveries.get(known)!;
      return { status: 200, body: { delivery_id: d.id, receipt: d.receipt } };
    }
    const inflight = this.admitting.get(idemKey);
    if (inflight) {
      const first = await inflight;
      return first.status === 202 ? { status: 200, body: first.body } : first;
    }
    const admission = this.admitNew(customer, request);
    this.admitting.set(idemKey, admission);
    try {
      return await admission;
    } finally {
      this.admitting.delete(idemKey);
    }
  }

  private async admitNew(customer: string, request: Exclude<ReturnType<typeof validateRequest>, string>): Promise<HttpReply> {
    const blocked = await this.checkTarget(request.url);
    if (blocked) return { status: 400, body: { error: `target refused: ${blocked}` } };

    const price = this.price();
    const acceptedAt = this.now();
    const id = "d_" + toHex(randomBytes(12));
    let receipt: Signed<ObligationReceipt> | undefined;
    const admitted = await this.charger.admit(customer, price, (seq) => {
      receipt = this.newReceipt({ id, customer, seq, price, request, acceptedAt });
      return { id, receiptsRoot: sha256Hex(canonicalJson(receipt)) };
    });
    if (!admitted.ok) return this.paymentRequired(customer, admitted.reason, admitted.balance);
    if (this.gone) return this.goneReply();

    const d: Delivery = { id, customer, request, receipt: receipt!, state: "pending", attempts: [], nextAttemptAt: acceptedAt, running: false, charge: true };
    this.addDelivery(d);
    this.journal.append({ t: "accepted", id, request, receipt: d.receipt, charge: true });
    if (this.charger.pendingCount() >= 40) void this.charger.flush();
    return { status: 202, body: { delivery_id: id, receipt: d.receipt } };
  }

  status(customer: string, id: string): HttpReply {
    if (this.gone) return this.goneReply();
    const d = this.deliveries.get(id);
    if (!d || d.customer !== customer) return { status: 404, body: { error: "unknown delivery" } };
    const body: StatusResponse = { delivery_id: d.id, state: d.state, receipt: d.receipt, attempts: d.attempts, next_attempt_at: d.state === "pending" ? d.nextAttemptAt : null };
    return { status: 200, body };
  }

  health() {
    return {
      ok: true,
      vault: this.vault,
      worker_public_key: this.publicKey,
      accepting: this.accepting,
      price_per_call: this.info ? this.price().toString() : "0",
      payment_token: this.info?.payment_token ?? "",
      queue: this.queueCounts(),
      ...(this.gone ? { moved_to: this.gone.endpoint } : {}),
    };
  }

  // ---------------------------------------------------------------- charging callbacks

  private onChargeSettled(item: PendingCharge, status: string, tx: string | undefined): void {
    const d = this.deliveries.get(item.id);
    if (d) d.chargeStatus = status;
    if (tx) this.lastChargeTx = tx;
    this.journal.append({ t: "charged", id: item.id, seq: item.seq, status, ...(tx ? { tx } : {}) });
  }

  private reissueReceipt(item: PendingCharge): string {
    const d = this.deliveries.get(item.id);
    if (!d) return item.receiptsRoot;
    d.receipt = this.newReceipt({ id: d.id, customer: d.customer, seq: item.seq, price: item.cost, request: d.request, acceptedAt: d.receipt.payload.accepted_at });
    this.journal.append({ t: "reseq", id: d.id, receipt: d.receipt });
    return sha256Hex(canonicalJson(d.receipt));
  }

  // ---------------------------------------------------------------- delivery engine

  private runDue(): void {
    if (this.gone) return;
    const limit = this.cfg.concurrency ?? 8;
    const now = this.now();
    for (const d of this.deliveries.values()) {
      if (this.running >= limit) return;
      if (d.state !== "pending" || d.running || d.nextAttemptAt === null || d.nextAttemptAt > now) continue;
      d.running = true;
      this.running += 1;
      void this.attempt(d).finally(() => {
        d.running = false;
        this.running -= 1;
      });
    }
  }

  private async attempt(d: Delivery): Promise<void> {
    const attempt = d.attempts.length + 1;
    let statusCode = 0;
    let responseSha256 = sha256Hex("");
    let error: string | undefined;
    let permanent = false;
    try {
      const res = await safeSend(
        { url: d.request.url, method: d.request.method, headers: { "content-type": "application/json", ...d.request.headers }, body: d.request.body },
        {
          allowTarget: this.cfg.allowTarget,
          ...(this.cfg.resolver ? { resolver: this.cfg.resolver } : {}),
          ...(this.cfg.timeoutMs ? { timeoutMs: this.cfg.timeoutMs } : {}),
          signHop: ({ url, method, body }) =>
            signOutbound(this.signer, {
              vault: this.vault,
              deliveryId: d.id,
              attempt,
              timestamp: this.now(),
              method,
              path: url.pathname + url.search,
              bodySha256: sha256Hex(body),
            }),
        },
      );
      statusCode = res.status;
      responseSha256 = res.responseSha256;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      permanent = e instanceof BlockedTargetError;
    }
    const at = this.now();
    const proof = signProof(this.signer, {
      delivery_id: d.id,
      vault: this.vault,
      attempt,
      status_code: statusCode,
      response_sha256: responseSha256,
      ...(error ? { error: error.slice(0, 200) } : {}),
      at,
      worker_public_key: this.publicKey,
    });
    d.attempts.push(proof);
    const outcome = permanent ? "permanent" : statusCode === 0 ? "retry" : classify(statusCode);
    let next: number | null = null;
    if (outcome === "delivered") d.state = "delivered";
    else if (outcome === "permanent") d.state = "failed";
    else {
      next = nextAttemptAt({
        acceptedAt: d.receipt.payload.accepted_at,
        now: at,
        attemptsMade: attempt,
        ...(this.cfg.retrySchedule ? { schedule: this.cfg.retrySchedule } : {}),
        ...(this.cfg.hourlyMs ? { hourlyMs: this.cfg.hourlyMs } : {}),
      });
      if (next === null) d.state = "failed";
    }
    d.nextAttemptAt = next;
    this.journal.append({ t: "attempt", id: d.id, proof, next_attempt_at: next });
    if (d.state !== "pending") this.journal.append({ t: "state", id: d.id, state: d.state });
    this.log(`${d.id} ${d.customer} attempt ${attempt}: ${statusCode || error} -> ${d.state}${next ? ` (retry in ${Math.round((next - at) / 1000)} s)` : ""}`);
  }

  // ---------------------------------------------------------------- handover

  /** Polls the vault: price, endpoint and, above all, whether this key is still the worker. */
  async watch(): Promise<void> {
    if (this.gone) return;
    const info = await this.chain.info();
    this.info = info;
    if (info.worker_key !== this.publicKey) {
      this.gone = { endpoint: info.endpoint.replace(/\/+$/, ""), worker_key: info.worker_key };
      this.log(`HANDOVER: vault worker key is now ${info.worker_key ?? "(none)"}; endpoint ${info.endpoint}. This worker stops accepting and charging.`);
      void this.retire();
    }
  }

  private retire(): Promise<void> {
    if (!this.retiring) this.retiring = this.retireOnce();
    return this.retiring;
  }

  private async retireOnce(): Promise<void> {
    const unsent = new Set(this.charger.stop().map((i) => i.id));
    // Let attempts that already started finish (they have their own timeout).
    for (let i = 0; i < 150 && this.running > 0; i++) await new Promise((r) => setTimeout(r, 100));
    // Pending deliveries go over to be delivered; delivered ones whose charge never went out
    // go over with their signed proofs, to be charged by the next worker.
    const entries: ObligationEntry[] = [];
    for (const d of this.deliveries.values()) {
      if (d.state === "pending") entries.push({ receipt: d.receipt, request: d.request });
      else if (d.state === "delivered" && unsent.has(d.id)) entries.push({ receipt: d.receipt, request: d.request, attempts: d.attempts });
    }
    if (unsent.size > 0) this.log(`${unsent.size} charges were not sent before the handover; they go to the next worker with the hand-off`);
    const target = this.gone!.endpoint;
    if ((this.cfg.handoff ?? true) && entries.length > 0 && target && target !== this.cfg.publicUrl.replace(/\/+$/, "")) {
      await this.handoff(target, entries);
    } else {
      this.log(`no hand-off: ${entries.length} open obligations${target ? "" : ", no endpoint on chain"}`);
    }
    this.stop();
    this.log("worker retired");
    this.cfg.onRetired?.();
  }

  private async handoff(endpoint: string, entries: ObligationEntry[]): Promise<void> {
    const envelope: HandoffEnvelope = { vault: this.vault, from_public_key: this.publicKey, created_at: this.now(), entries };
    const doc = signDocument(HANDOFF_DOMAIN, this.signer, envelope);
    // 60 x 3 s = 3 min: the new worker only listens after its key and config views come
    // back, which through a rate-shaped public RPC can take a couple of minutes.
    const attempts = this.cfg.handoffAttempts ?? 60;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(`${endpoint}/v1/handoff`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(doc),
          // The new worker may need a queued on-chain view (worker-key history) before it
          // can accept; through a rate-shaped proxy that can take well over 15 s.
          signal: AbortSignal.timeout(90_000),
        });
        if (res.ok) {
          const body = (await res.json()) as { results: ObligationResult[] };
          const accepted = body.results.filter((r) => r.result !== "rejected").length;
          this.log(`hand-off to ${endpoint}: ${accepted} of ${entries.length} obligations taken over`);
          return;
        }
        this.log(`hand-off attempt ${i} answered ${res.status}`);
      } catch (e) {
        this.log(`hand-off attempt ${i} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((r) => setTimeout(r, this.cfg.handoffDelayMs ?? 3000));
    }
    this.log("hand-off gave up; customers can still present their receipts to the new worker");
  }

  private async workerKeys(force = false): Promise<Set<string>> {
    if (!force && this.history && this.now() - this.history.at < HISTORY_CACHE_MS) return this.history.keys;
    const list = await this.chain.workerHistory();
    const keys = new Set(list.map((k) => k.public_key));
    keys.add(this.publicKey);
    this.history = { at: this.now(), keys };
    return keys;
  }

  private async isVaultWorkerKey(key: string): Promise<boolean> {
    return (await this.workerKeys()).has(key) || (await this.workerKeys(true)).has(key);
  }

  /** A hand-off from a previous worker of this vault. */
  async acceptHandoff(input: unknown): Promise<HttpReply> {
    if (this.gone) return this.goneReply();
    const doc = input as Signed<HandoffEnvelope>;
    const env = doc?.payload;
    if (!env || typeof env !== "object" || !Array.isArray(env.entries) || typeof env.from_public_key !== "string") {
      return { status: 400, body: { error: "bad hand-off envelope" } };
    }
    if (env.vault !== this.vault) return { status: 400, body: { error: "hand-off for another vault" } };
    if (env.from_public_key === this.publicKey) return { status: 400, body: { error: "hand-off from this worker's own key" } };
    if (!verifyDocument(HANDOFF_DOMAIN, doc, env.from_public_key)) return { status: 401, body: { error: "bad hand-off signature" } };
    if (!(await this.isVaultWorkerKey(env.from_public_key))) return { status: 401, body: { error: "hand-off key was never a worker key of this vault" } };
    const results: ObligationResult[] = [];
    for (const entry of env.entries) results.push(await this.takeOver(entry, null));
    this.log(`hand-off received from the previous worker: ${summarizeResults(results)}`);
    return { status: 200, body: { results } };
  }

  /** Obligations a customer presents again (after a 410 or a dead endpoint). */
  async acceptObligations(customer: string, input: unknown): Promise<HttpReply> {
    if (this.gone) return this.goneReply();
    const entries = (input as { entries?: unknown })?.entries;
    if (!Array.isArray(entries) || entries.length > 500) return { status: 400, body: { error: "entries must be an array of at most 500" } };
    const results: ObligationResult[] = [];
    for (const entry of entries as ObligationEntry[]) results.push(await this.takeOver(entry, customer));
    if (results.some((r) => r.result !== "known")) this.log(`receipts presented by ${customer}: ${summarizeResults(results)}`);
    return { status: 200, body: { results } };
  }

  /**
   * Takes over one obligation signed by a worker key of this vault. If its seq was already
   * charged on chain (at or below the customer's seq when this worker first saw them), it is
   * delivered without charging again; otherwise it is charged as new.
   */
  private async takeOver(entry: ObligationEntry, customer: string | null): Promise<ObligationResult> {
    const r = entry?.receipt?.payload;
    const id = typeof r?.delivery_id === "string" ? r.delivery_id : "";
    const reject = (reason: string): ObligationResult => ({ delivery_id: id, result: "rejected", reason });
    if (!r || !/^d_[0-9a-f]{24}$/.test(id)) return reject("bad receipt");
    if (r.vault !== this.vault) return reject("receipt for another vault");
    if (customer !== null && r.customer !== customer) return reject("receipt of another customer");
    if (!verifyReceipt(entry.receipt)) return reject("bad receipt signature");
    if (!(await this.isVaultWorkerKey(r.worker_public_key))) return reject("receipt key was never a worker key of this vault");
    const request = validateRequest(entry.request);
    if (typeof request === "string") return reject(`bad request: ${request}`);
    if (sha256Hex(request.url) !== r.target_url_sha256 || sha256Hex(request.body) !== r.body_sha256) return reject("request does not match the receipt");

    const existing = this.deliveries.get(id);
    if (existing) return { delivery_id: id, result: "known", receipt: existing.receipt };

    let floor: number | null;
    try {
      floor = await this.charger.floorOf(r.customer);
    } catch (e) {
      return reject(`chain read failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (floor === null) return reject("customer has no entry in the vault");
    const already = r.seq <= floor;
    let receipt = entry.receipt;
    let charge = false;
    if (!already) {
      const price = this.price();
      const admitted = await this.charger.admit(r.customer, price, (seq) => {
        receipt = this.newReceipt({ id, customer: r.customer, seq, price, request, acceptedAt: r.accepted_at });
        return { id, receiptsRoot: sha256Hex(canonicalJson(receipt)) };
      });
      if (!admitted.ok) return reject(`payment_required: ${admitted.reason}`);
      charge = true;
    }
    // A hand-off may say the old worker already delivered it (only the charge was open).
    const proofs = customer === null ? this.deliveredProofs(entry, r) : null;
    const d: Delivery = {
      id,
      customer: r.customer,
      request,
      receipt,
      state: proofs ? "delivered" : "pending",
      attempts: proofs ?? [],
      nextAttemptAt: proofs ? null : this.now(),
      running: false,
      charge,
    };
    this.addDelivery(d);
    this.journal.append({ t: "accepted", id, request, receipt, charge });
    if (proofs) {
      for (const proof of proofs) this.journal.append({ t: "attempt", id, proof, next_attempt_at: null });
      this.journal.append({ t: "state", id, state: "delivered" });
    }
    return { delivery_id: id, result: "accepted", charged_as_new: charge, receipt };
  }

  /** The old worker's proofs if they show a successful delivery by the key that accepted it. */
  private deliveredProofs(entry: ObligationEntry, r: ObligationReceipt): Signed<DeliveryProof>[] | null {
    const proofs = entry.attempts;
    if (!Array.isArray(proofs) || proofs.length === 0 || proofs.length > 50) return null;
    for (const p of proofs) {
      const ok = verifyProof(p) && p.payload.delivery_id === r.delivery_id && p.payload.vault === this.vault && p.payload.worker_public_key === r.worker_public_key;
      if (!ok) return null;
    }
    const last = proofs[proofs.length - 1]!.payload.status_code;
    return last >= 200 && last < 300 ? proofs : null;
  }

  /** For tests and the CLI: send pending charges now. */
  flushCharges(): Promise<void> {
    return this.charger.flush();
  }
}
