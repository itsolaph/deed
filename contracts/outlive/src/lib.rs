//! Outlive: an NEP-171 registry where each token owns a running paid API.
//!
//! Minting a token creates the business vault on the sub-account `<slug>.<outlive account>`.
//! The holder of the token is the vault owner: after every final ownership change the outlive
//! pushes the new owner and an increasing epoch to the vault. The built-in sale is the only
//! sale path (no NEP-178 approvals), and listing locks the vault until the sale or cancel.

use near_sdk::json_types::U128;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseError,
};

mod events;
mod mint;
mod nft;
mod ownership;
mod sale;
pub mod slug;
pub mod svg;
mod views;

pub use views::{OutliveView, ListingView, VaultCodeHash};

/// Optimized vault build, embedded at compile time. `scripts/build.sh` builds the vault first.
pub const VAULT_WASM: &[u8] = include_bytes!("../../target/near/vault/vault.wasm");

/// Vault state, ledger entries of the first customers and access key storage.
pub const VAULT_STATE_RESERVE: NearToken = NearToken::from_millinear(50);
/// Starting NEAR for the vault's own gas (charges are paid from the vault balance).
pub const VAULT_GAS_TANK: NearToken = NearToken::from_millinear(500);
/// Outlive-side storage for one token record and its stats.
pub const TOKEN_STORAGE_RESERVE: NearToken = NearToken::from_millinear(10);
/// NEP-145 registration of the vault on the payment token.
pub const FT_STORAGE_DEPOSIT: NearToken = NearToken::from_micronear(1_250);

pub const GAS_VAULT_NEW: Gas = Gas::from_tgas(30);
pub const GAS_ON_VAULT_CREATED: Gas = Gas::from_tgas(40);
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub const GAS_SET_OWNER: Gas = Gas::from_tgas(10);
pub const GAS_ON_OWNER_PUSHED: Gas = Gas::from_tgas(5);
pub const GAS_LOCK: Gas = Gas::from_tgas(10);
pub const GAS_ON_LOCKED: Gas = Gas::from_tgas(15);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub const GAS_ON_PAID: Gas = Gas::from_tgas(10);
pub const GAS_CALLBACK_SMALL: Gas = Gas::from_tgas(10);
/// nft_resolve_transfer may push the final owner to the vault.
pub const GAS_RESOLVE_TRANSFER: Gas = Gas::from_tgas(30);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Tokens,
    OwnerTokens,
    PendingMints,
    Proceeds,
}

/// Figures pushed by the vault. The field names match the vault's `VaultStats`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
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

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Listing {
    /// Unique per token and increasing. Also the vault lock id, and buyers may pin it.
    pub id: u64,
    pub seller: AccountId,
    pub price: u128,
    /// False until the vault confirmed the lock.
    pub active: bool,
    pub epoch: u64,
    pub listed_at: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct TokenRecord {
    pub owner_id: AccountId,
    /// Increases with every final ownership change and is pushed to the vault.
    pub owner_epoch: u64,
    pub vault_id: AccountId,
    pub title: String,
    pub price_at_mint: u128,
    pub minted_at: u64,
    pub stats: Option<VaultStats>,
    pub listing: Option<Listing>,
    /// Id of the newest listing ever made for this token (0 if never listed).
    pub last_listing_id: u64,
    /// Set between nft_transfer_call and nft_resolve_transfer.
    pub transfer_call_pending: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Outlive {
    /// Has no on-chain powers in this version. Kept as the published operator contact.
    admin_id: AccountId,
    payment_token: AccountId,
    payment_symbol: String,
    tokens: IterableMap<String, TokenRecord>,
    owner_tokens: LookupMap<AccountId, Vec<String>>,
    /// Slugs with a vault creation in flight, mapped to the minter.
    pending_mints: LookupMap<String, AccountId>,
    /// Sale proceeds that could not be paid out (seller not registered on the token).
    proceeds: LookupMap<AccountId, u128>,
    proceeds_total: u128,
    proceeds_in_flight: u128,
}

pub(crate) fn promise_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 1_024), Err(PromiseError::Failed))
}

#[near]
impl Outlive {
    /// Private, so only the outlive account itself can initialize (deploy and init in one batch).
    #[init]
    #[private]
    pub fn new(admin_id: AccountId, payment_token: AccountId, payment_symbol: Option<String>) -> Self {
        let payment_symbol = payment_symbol.unwrap_or_else(|| "USDC".to_string());
        require!(
            !payment_symbol.is_empty() && payment_symbol.len() <= 12,
            "payment_symbol must be 1 to 12 characters"
        );
        Self {
            admin_id,
            payment_token,
            payment_symbol,
            tokens: IterableMap::new(StorageKey::Tokens),
            owner_tokens: LookupMap::new(StorageKey::OwnerTokens),
            pending_mints: LookupMap::new(StorageKey::PendingMints),
            proceeds: LookupMap::new(StorageKey::Proceeds),
            proceeds_total: 0,
            proceeds_in_flight: 0,
        }
    }
}

impl Outlive {
    pub(crate) fn token(&self, token_id: &str) -> &TokenRecord {
        self.tokens.get(token_id).unwrap_or_else(|| env::panic_str("token not found"))
    }

    pub(crate) fn token_mut(&mut self, token_id: &str) -> &mut TokenRecord {
        self.tokens.get_mut(token_id).unwrap_or_else(|| env::panic_str("token not found"))
    }
}
