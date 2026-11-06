// Typed views of the outlive and vault contracts (see docs/CONTRACTS.md). Browser-safe.

import { Rpc } from "./chain.js";

export interface VaultInfo {
  /** Explicit capability; receipt versions do not identify vault protocols. */
  protocol_version?: number;
  worker_rotation_pending?: { op_id: number; public_key: string; previous: string | null; allowance: string; owner_epoch: number } | null;
  outlive_id: string;
  token_id: string;
  owner_id: string;
  owner_epoch: number;
  locked: boolean;
  lock_id: number;
  payment_token: string;
  price_per_call: string;
  pending_price: string | null;
  price_effective_at_ms: string | null;
  endpoint: string;
  image_hash: string;
  worker_key: string | null;
  revenue: string;
  liabilities: string;
  in_flight: string;
  customers: number;
  charged_items: string;
  default_daily_cap: string;
  min_deposit: string;
  refund_delay_sec: number;
  stats_interval_sec: number;
  near_balance: string;
  created_at_ms: string;
}

export interface CustomerView {
  balance: string;
  daily_cap: string;
  pending_daily_cap: string | null;
  daily_cap_effective_at_ms: string | null;
  spent_today: string;
  chargeable_today: string;
  day: number;
  last_seq: string;
  refund_requested_at_ms: string | null;
  refund_available_at_ms: string | null;
}

export interface DayBucket {
  day: number;
  calls: number;
  revenue: string;
  gas_spent: string;
}

export interface VaultStatsView {
  today: number;
  calls_30d: number;
  revenue_30d: string;
  gas_spent_30d: string;
  calls_total: number;
  revenue_total: string;
  /** Days with activity in the last 30, oldest first. */
  days: DayBucket[];
}

export interface WorkerKeyView {
  public_key: string;
  set_at_ms: string;
  owner_epoch: number;
}

export interface ChargeItem {
  /** Required and enforced by v2; legacy v1 ignores this field. */
  quoted_price?: string;
  customer: string;
  seq: number;
  units: number;
  receipts_root: string;
}

export interface ChargeResult {
  customer: string;
  seq: number;
  status: string;
  cost: string;
}

export interface ListingView {
  token_id: string;
  /** Pass as `listing_id` in the buy message to pin the purchase to this listing. */
  listing_id: number;
  seller: string;
  price: string;
  active: boolean;
  epoch: number;
  listed_at_ms: string;
}

/** Stats the vault pushes to the token (shown in the NFT metadata). */
export interface PushedStats {
  calls_30d: number;
  revenue_30d: string;
  gas_spent_30d: string;
  cash: string;
  liabilities: string;
  price_per_call: string;
  customers: number;
  owner_epoch: number;
  updated_at_ms: number;
}

export interface OutliveView {
  token_id: string;
  title: string;
  owner_id: string;
  owner_epoch: number;
  vault_id: string;
  price_at_mint: string;
  minted_at_ms: string;
  stats: PushedStats | null;
  listing: ListingView | null;
  transfer_call_pending: boolean;
}

export interface OutliveConfig {
  admin_id: string;
  payment_token: string;
  payment_symbol: string;
  mint_cost: string;
  proceeds_total: string;
  proceeds_in_flight: string;
}

export interface NftToken {
  token_id: string;
  owner_id: string;
  metadata: {
    title: string | null;
    description: string | null;
    media: string | null;
    updated_at: string | null;
    extra: string | null;
  } | null;
}

export class VaultViews {
  constructor(
    readonly rpc: Rpc,
    readonly vault: string,
  ) {}

  info(): Promise<VaultInfo> {
    return this.rpc.view<VaultInfo>(this.vault, "get_info");
  }

  customer(accountId: string): Promise<CustomerView | null> {
    return this.rpc.view<CustomerView | null>(this.vault, "get_customer", { account_id: accountId });
  }

  stats(): Promise<VaultStatsView> {
    return this.rpc.view<VaultStatsView>(this.vault, "get_stats");
  }

  workerHistory(): Promise<WorkerKeyView[]> {
    return this.rpc.view<WorkerKeyView[]>(this.vault, "get_worker_history");
  }
}

export class OutliveViews {
  constructor(
    readonly rpc: Rpc,
    readonly outlive: string,
  ) {}

  outliveOf(tokenId: string): Promise<OutliveView | null> {
    return this.rpc.view<OutliveView | null>(this.outlive, "get_token", { token_id: tokenId });
  }

  tokens(fromIndex = 0, limit = 50): Promise<OutliveView[]> {
    return this.rpc.view<OutliveView[]>(this.outlive, "get_tokens", { from_index: fromIndex, limit });
  }

  listings(fromIndex = 0, limit = 50): Promise<ListingView[]> {
    return this.rpc.view<ListingView[]>(this.outlive, "get_listings", { from_index: fromIndex, limit });
  }

  config(): Promise<OutliveConfig> {
    return this.rpc.view<OutliveConfig>(this.outlive, "get_config");
  }

  token(tokenId: string): Promise<NftToken | null> {
    return this.rpc.view<NftToken | null>(this.outlive, "nft_token", { token_id: tokenId });
  }

  mintCost(): Promise<string> {
    return this.rpc.view<string>(this.outlive, "mint_cost");
  }
}

/** Account id of the vault for `tokenId` under `outlive`. */
export function vaultAccountFor(outlive: string, tokenId: string): string {
  return `${tokenId}.${outlive}`;
}
