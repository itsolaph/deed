//! Read-only views.

use near_sdk::json_types::{U128, U64};
use near_sdk::{env, near, AccountId, PublicKey};

use crate::ledger::{utc_day, Customer};
use crate::stats::StatsView;
use crate::{Vault, VaultExt, MIN_CUSTOMER_DEPOSIT};

#[near(serializers = [json])]
pub struct VaultInfo {
    pub deed_id: AccountId,
    pub token_id: String,
    pub owner_id: AccountId,
    pub owner_epoch: u64,
    pub locked: bool,
    pub payment_token: AccountId,
    pub price_per_call: U128,
    pub pending_price: Option<U128>,
    pub price_effective_at_ms: Option<U64>,
    pub endpoint: String,
    pub image_hash: String,
    pub worker_key: Option<PublicKey>,
    pub revenue: U128,
    pub liabilities: U128,
    pub in_flight: U128,
    pub customers: u32,
    pub charged_items: U64,
    pub default_daily_cap: U128,
    pub min_deposit: U128,
    pub refund_delay_sec: u64,
    pub stats_interval_sec: u64,
    pub near_balance: U128,
    pub created_at_ms: U64,
}

#[near(serializers = [json])]
pub struct CustomerView {
    pub balance: U128,
    pub daily_cap: U128,
    pub spent_today: U128,
    pub chargeable_today: U128,
    pub day: u32,
    pub last_seq: U64,
    pub refund_requested_at_ms: Option<U64>,
    pub refund_available_at_ms: Option<U64>,
}

#[near(serializers = [json])]
pub struct WorkerKeyView {
    pub public_key: PublicKey,
    pub set_at_ms: U64,
    pub owner_epoch: u64,
}

/// Pushed to the deed and shown in the NFT metadata. Field names are part of the deed's
/// `on_stats` interface.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct VaultStats {
    pub calls_30d: u64,
    pub revenue_30d: U128,
    pub gas_spent_30d: U128,
    pub cash: U128,
    pub liabilities: U128,
    pub price_per_call: U128,
    pub customers: u32,
    pub owner_epoch: u64,
    pub updated_at_ms: u64,
}

fn ms(ns: u64) -> U64 {
    U64(ns / 1_000_000)
}

impl Vault {
    pub(crate) fn current_stats(&self) -> VaultStats {
        let (calls, revenue, gas) = self.stats.totals(self.today());
        VaultStats {
            calls_30d: calls,
            revenue_30d: U128(revenue),
            gas_spent_30d: U128(gas),
            cash: U128(self.revenue),
            liabilities: U128(self.liabilities),
            price_per_call: U128(self.price.effective(env::block_timestamp())),
            customers: self.customer_count,
            owner_epoch: self.owner_epoch,
            updated_at_ms: env::block_timestamp_ms(),
        }
    }

    fn customer_view(&self, c: &Customer) -> CustomerView {
        let today = utc_day(env::block_timestamp());
        CustomerView {
            balance: U128(c.balance),
            daily_cap: U128(c.daily_cap),
            spent_today: U128(c.spent_on(today)),
            chargeable_today: U128(c.chargeable_today(today)),
            day: c.day,
            last_seq: U64(c.last_seq),
            refund_requested_at_ms: c.refund_requested_at.map(ms),
            refund_available_at_ms: c.refund_available_at(self.refund_delay_ns).map(ms),
        }
    }
}

#[near]
impl Vault {
    pub fn get_info(&self) -> VaultInfo {
        let now = env::block_timestamp();
        let pending = self.price.pending.filter(|(_, at)| now < *at);
        VaultInfo {
            deed_id: self.deed_id.clone(),
            token_id: self.token_id.clone(),
            owner_id: self.owner_id.clone(),
            owner_epoch: self.owner_epoch,
            locked: self.locked,
            payment_token: self.payment_token.clone(),
            price_per_call: U128(self.price.effective(now)),
            pending_price: pending.map(|(p, _)| U128(p)),
            price_effective_at_ms: pending.map(|(_, at)| ms(at)),
            endpoint: self.endpoint.clone(),
            image_hash: self.image_hash.clone(),
            worker_key: self.worker_key.clone(),
            revenue: U128(self.revenue),
            liabilities: U128(self.liabilities),
            in_flight: U128(self.in_flight),
            customers: self.customer_count,
            charged_items: U64(self.charged_items),
            default_daily_cap: U128(self.default_daily_cap),
            min_deposit: U128(MIN_CUSTOMER_DEPOSIT),
            refund_delay_sec: self.refund_delay_ns / 1_000_000_000,
            stats_interval_sec: self.stats_interval_ns / 1_000_000_000,
            near_balance: U128(env::account_balance().as_yoctonear()),
            created_at_ms: ms(self.created_at),
        }
    }

    pub fn get_customer(&self, account_id: AccountId) -> Option<CustomerView> {
        self.customers.get(&account_id).map(|c| self.customer_view(c))
    }

    pub fn get_stats(&self) -> StatsView {
        self.stats.view(self.today())
    }

    /// Stats in the shape pushed to the deed.
    pub fn get_push_stats(&self) -> VaultStats {
        self.current_stats()
    }

    /// Recent worker keys, newest last, for verifying receipts signed by earlier workers.
    pub fn get_worker_history(&self) -> Vec<WorkerKeyView> {
        self.worker_history
            .iter()
            .map(|r| WorkerKeyView {
                public_key: r.public_key.clone(),
                set_at_ms: ms(r.set_at),
                owner_epoch: r.owner_epoch,
            })
            .collect()
    }
}
