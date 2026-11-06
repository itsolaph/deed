//! Outlive vault. One vault per business, deployed by the outlive contract on `<slug>.<outlive account>`.
//!
//! The vault holds the business treasury (payment-token balance), the price list, the customer
//! ledger and the worker authorization. Its owner is whoever holds the outlive token; the outlive
//! pushes every ownership change here with an increasing epoch.
//!
//! The vault account never holds a full-access key. Its only key is the current worker's
//! function-call key, restricted to `charge` on the vault itself, which the vault adds itself.

use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseError,
    PublicKey,
};

mod charge;
mod customer;
mod events;
mod hooks;
pub mod ledger;
mod owner;
pub mod pricing;
pub mod stats;
mod views;

pub use charge::{ChargeItem, ChargeResult};
pub use views::{CustomerView, VaultInfo, VaultStats, WorkerKeyView};

use ledger::{utc_day, Customer, NS_PER_SEC};
use pricing::PriceSchedule;
use stats::StatsRing;

pub const DEFAULT_REFUND_DELAY_SEC: u64 = 600;
pub const MAX_REFUND_DELAY_SEC: u64 = 3_600;
pub const DEFAULT_STATS_INTERVAL_SEC: u64 = 600;
/// First deposit of a new customer must be at least this much (1.0 of a 6-decimal token),
/// so creating ledger entries costs real money.
pub const MIN_CUSTOMER_DEPOSIT: u128 = 1_000_000;
pub const MAX_ENDPOINT_LEN: usize = 256;
pub const MAX_IMAGE_HASH_LEN: usize = 128;
pub const MAX_TOKEN_ID_LEN: usize = 32;
/// Keeps one `vault_charge` event well under the 16 KB log limit.
pub const MAX_CHARGE_ITEMS: usize = 40;
pub const DEFAULT_WORKER_ALLOWANCE: NearToken = NearToken::from_millinear(500);
pub const MAX_WORKER_ALLOWANCE: NearToken = NearToken::from_near(5);
pub const WORKER_HISTORY_LEN: usize = 10;
pub const WORKER_METHODS: &str = "charge";

pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub const GAS_CALLBACK: Gas = Gas::from_tgas(10);
pub const GAS_STATS_PUSH: Gas = Gas::from_tgas(10);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Customers,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct WorkerKeyRecord {
    pub public_key: PublicKey,
    pub set_at: u64,
    pub owner_epoch: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    outlive_id: AccountId,
    token_id: String,
    owner_id: AccountId,
    owner_epoch: u64,
    /// Set while the token is listed for sale. Blocks withdraw, set_worker, set_config, set_price.
    locked: bool,
    /// Listing id of the newest lock. Lock ids only grow, so a lock or unlock that arrives
    /// late (receipts between two accounts are not formally ordered) is ignored.
    lock_id: u64,
    payment_token: AccountId,
    price: PriceSchedule,
    endpoint: String,
    image_hash: String,
    default_daily_cap: u128,
    refund_delay_ns: u64,
    stats_interval_ns: u64,
    worker_key: Option<PublicKey>,
    /// Most recent worker keys, newest last, so clients can verify old receipts.
    worker_history: Vec<WorkerKeyRecord>,
    customers: LookupMap<AccountId, Customer>,
    customer_count: u32,
    /// Sum of all customer balances. Never withdrawable.
    liabilities: u128,
    /// Earned and withdrawable by the owner.
    revenue: u128,
    /// Sent out with ft_transfer and not yet confirmed by a callback.
    in_flight: u128,
    /// Total charge items applied. New customers start their seq above this value.
    charged_items: u64,
    stats: StatsRing,
    last_stats_push: u64,
    /// Account balance after the last gas measurement (see `track_gas`).
    gas_checkpoint: u128,
    created_at: u64,
}

pub(crate) fn parent_of(account: &str) -> Option<&str> {
    account.split_once('.').map(|(_, parent)| parent)
}

pub(crate) fn promise_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 1_024), Err(PromiseError::Failed))
}

pub(crate) fn validate_config(endpoint: &str, image_hash: &str) {
    require!(endpoint.len() <= MAX_ENDPOINT_LEN, "endpoint too long");
    require!(image_hash.len() <= MAX_IMAGE_HASH_LEN, "image_hash too long");
}

#[near]
impl Vault {
    /// Only the parent account (the outlive) may initialize, inside the creation batch.
    #[init]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        token_id: String,
        owner_id: AccountId,
        payment_token: AccountId,
        price_per_call: U128,
        endpoint: String,
        image_hash: String,
        default_daily_cap: U128,
        refund_delay_sec: Option<u64>,
        stats_interval_sec: Option<u64>,
    ) -> Self {
        let current = env::current_account_id();
        let outlive_id = env::predecessor_account_id();
        require!(
            parent_of(current.as_str()) == Some(outlive_id.as_str()),
            "only the parent Outlive account may initialize the vault"
        );
        require!(!token_id.is_empty() && token_id.len() <= MAX_TOKEN_ID_LEN, "bad token_id");
        require!(price_per_call.0 > 0, "price must be positive");
        validate_config(&endpoint, &image_hash);
        let refund_delay_sec = refund_delay_sec.unwrap_or(DEFAULT_REFUND_DELAY_SEC);
        require!(refund_delay_sec <= MAX_REFUND_DELAY_SEC, "refund delay above 1 hour");
        let stats_interval_sec = stats_interval_sec.unwrap_or(DEFAULT_STATS_INTERVAL_SEC);
        let now = env::block_timestamp();

        events::emit(
            "vault_init",
            near_sdk::serde_json::json!({
                "outlive_id": outlive_id,
                "token_id": token_id,
                "owner_id": owner_id,
                "owner_epoch": 1,
                "payment_token": payment_token,
                "price_per_call": price_per_call,
                "refund_delay_sec": refund_delay_sec,
            }),
        );

        Self {
            outlive_id,
            token_id,
            owner_id,
            owner_epoch: 1,
            locked: false,
            lock_id: 0,
            payment_token,
            price: PriceSchedule::new(price_per_call.0),
            endpoint,
            image_hash,
            default_daily_cap: default_daily_cap.0,
            refund_delay_ns: refund_delay_sec * NS_PER_SEC,
            stats_interval_ns: stats_interval_sec.saturating_mul(NS_PER_SEC),
            worker_key: None,
            worker_history: Vec::new(),
            customers: LookupMap::new(StorageKey::Customers),
            customer_count: 0,
            liabilities: 0,
            revenue: 0,
            in_flight: 0,
            charged_items: 0,
            stats: StatsRing::default(),
            last_stats_push: now,
            gas_checkpoint: env::account_balance().as_yoctonear(),
            created_at: now,
        }
    }
}

impl Vault {
    pub(crate) fn today(&self) -> u32 {
        utc_day(env::block_timestamp())
    }

    pub(crate) fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the token owner");
    }

    pub(crate) fn assert_unlocked(&self) {
        require!(!self.locked, "vault is locked while the token is listed");
    }

    pub(crate) fn assert_outlive(&self) {
        require!(env::predecessor_account_id() == self.outlive_id, "only the outlive contract");
    }

    /// Approximate gas accounting: any drop of the account balance since the last measurement
    /// is counted as gas spent today, any rise (gas refunds) is subtracted. `incoming` is the
    /// deposit attached to the current call, which is not counted.
    pub(crate) fn track_gas(&mut self, incoming: u128) {
        let balance = env::account_balance().as_yoctonear();
        let without_incoming = balance.saturating_sub(incoming);
        let delta = self.gas_checkpoint as i128 - without_incoming as i128;
        if delta != 0 {
            let today = self.today();
            self.stats.record_gas(today, delta);
        }
        self.gas_checkpoint = balance;
    }
}
