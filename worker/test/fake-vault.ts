// In-memory vault with the same charge rules as contracts/vault (seq, balance, daily cap,
// worker key), so worker tests run without a chain.

import type { ChargeItem, ChargeResult, CustomerView, VaultInfo, WorkerKeyView } from "@outlive/sdk";
import type { ChargeOutcome, KeyPermission, VaultChain } from "../src/vault-chain.js";

interface FakeCustomer {
  balance: bigint;
  cap: bigint;
  spent: bigint;
  lastSeq: number;
  refundRequestedAt: number | null;
}

export class FakeVault {
  readonly vault = "relay.outlive.test";
  workerKey: string | null = null;
  endpoint = "http://127.0.0.1:1";
  price = 10_000n;
  revenue = 0n;
  chargedItems = 0;
  readonly history: WorkerKeyView[] = [];
  readonly customers = new Map<string, FakeCustomer>();
  readonly fullKeys = new Map<string, Set<string>>();
  readonly charges: { signer: string; items: ChargeItem[]; results: ChargeResult[] }[] = [];
  txCounter = 0;

  setWorker(publicKey: string, endpoint?: string): void {
    this.workerKey = publicKey;
    this.history.push({ public_key: publicKey, set_at_ms: String(Date.now()), owner_epoch: 1 });
    if (endpoint) this.endpoint = endpoint;
  }

  addCustomer(account: string, publicKey: string, balance: bigint, cap = 10n ** 12n): void {
    this.customers.set(account, { balance, cap, spent: 0n, lastSeq: this.chargedItems, refundRequestedAt: null });
    const keys = this.fullKeys.get(account) ?? new Set();
    keys.add(publicKey);
    this.fullKeys.set(account, keys);
  }

  liabilities(): bigint {
    let n = 0n;
    for (const c of this.customers.values()) n += c.balance;
    return n;
  }

  infoView(): VaultInfo {
    return {
      outlive_id: "outlive.test",
      token_id: "relay",
      owner_id: "seller.test",
      owner_epoch: 1,
      locked: false,
      lock_id: 0,
      payment_token: "tusdc.test",
      price_per_call: this.price.toString(),
      pending_price: null,
      price_effective_at_ms: null,
      endpoint: this.endpoint,
      image_hash: "sha256:test",
      worker_key: this.workerKey,
      revenue: this.revenue.toString(),
      liabilities: this.liabilities().toString(),
      in_flight: "0",
      customers: this.customers.size,
      charged_items: String(this.chargedItems),
      default_daily_cap: "1000000000000",
      min_deposit: "1000000",
      refund_delay_sec: 600,
      stats_interval_sec: 600,
      near_balance: "0",
      created_at_ms: "0",
    };
  }

  customerView(account: string): CustomerView | null {
    const c = this.customers.get(account);
    if (!c) return null;
    const capLeft = c.cap - c.spent;
    return {
      balance: c.balance.toString(),
      daily_cap: c.cap.toString(),
      pending_daily_cap: null,
      daily_cap_effective_at_ms: null,
      spent_today: c.spent.toString(),
      chargeable_today: (capLeft < c.balance ? capLeft : c.balance).toString(),
      day: 1,
      last_seq: String(c.lastSeq),
      refund_requested_at_ms: c.refundRequestedAt === null ? null : String(c.refundRequestedAt),
      refund_available_at_ms: null,
    };
  }

  applyCharge(signer: string, items: ChargeItem[]): ChargeOutcome {
    if (signer !== this.workerKey) return { ok: false, results: [], error: "Smart contract panicked: signer key is not the registered worker key" };
    const results: ChargeResult[] = items.map((item) => {
      const c = this.customers.get(item.customer);
      const out = (status: string, cost = 0n) => ({ customer: item.customer, seq: item.seq, status, cost: cost.toString() });
      if (!/^[0-9a-f]{64}$/i.test(item.receipts_root)) return out("invalid_receipts_root");
      if (!c) return out("unknown_customer");
      if (item.seq <= c.lastSeq) return out("duplicate");
      if (item.seq !== c.lastSeq + 1) return out("seq_gap");
      const cost = this.price * BigInt(item.units);
      if (cost > c.balance) return out("insufficient_balance");
      if (c.spent + cost > c.cap) return out("over_daily_cap");
      c.balance -= cost;
      c.spent += cost;
      c.lastSeq = item.seq;
      this.revenue += cost;
      this.chargedItems += 1;
      return out("charged", cost);
    });
    this.charges.push({ signer, items, results });
    return { ok: true, hash: `tx${++this.txCounter}`, results };
  }

  /** The chain as seen by a worker that signs with `publicKey`. */
  as(publicKey: string): VaultChain {
    return {
      vault: this.vault,
      info: async () => this.infoView(),
      customer: async (a) => this.customerView(a),
      workerHistory: async () => this.history.slice(-10),
      keyPermission: async (account, pk): Promise<KeyPermission> => {
        if (account === this.vault) return pk === this.workerKey ? "function_call" : null;
        return this.fullKeys.get(account)?.has(pk) ? "full" : null;
      },
      workerAllowance: async () => 10n ** 24n,
      charge: async (items) => this.applyCharge(publicKey, items),
    };
  }
}
