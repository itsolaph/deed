//! Read-only views beyond the NFT standards.

use near_sdk::json_types::{U128, U64};
use near_sdk::{bs58, env, near, AccountId, NearToken};

use crate::{Deed, DeedExt, Listing, TokenRecord, VaultStats, VAULT_WASM};

#[near(serializers = [json])]
pub struct ListingView {
    pub token_id: String,
    pub seller: AccountId,
    pub price: U128,
    pub active: bool,
    pub epoch: u64,
    pub listed_at_ms: U64,
}

#[near(serializers = [json])]
pub struct DeedView {
    pub token_id: String,
    pub title: String,
    pub owner_id: AccountId,
    pub owner_epoch: u64,
    pub vault_id: AccountId,
    pub price_at_mint: U128,
    pub minted_at_ms: U64,
    pub stats: Option<VaultStats>,
    pub listing: Option<ListingView>,
    pub transfer_call_pending: bool,
}

#[near(serializers = [json])]
pub struct VaultCodeHash {
    pub sha256_hex: String,
    /// Same hash in base58, as shown by `near` CLI and explorers for a deployed contract.
    pub sha256_base58: String,
    pub size_bytes: u32,
}

#[near(serializers = [json])]
pub struct DeedConfig {
    pub admin_id: AccountId,
    pub payment_token: AccountId,
    pub payment_symbol: String,
    pub mint_cost: NearToken,
    pub proceeds_total: U128,
    pub proceeds_in_flight: U128,
}

fn listing_view(token_id: &str, l: &Listing) -> ListingView {
    ListingView {
        token_id: token_id.to_string(),
        seller: l.seller.clone(),
        price: U128(l.price),
        active: l.active,
        epoch: l.epoch,
        listed_at_ms: U64(l.listed_at / 1_000_000),
    }
}

fn deed_view(token_id: &str, r: &TokenRecord) -> DeedView {
    DeedView {
        token_id: token_id.to_string(),
        title: r.title.clone(),
        owner_id: r.owner_id.clone(),
        owner_epoch: r.owner_epoch,
        vault_id: r.vault_id.clone(),
        price_at_mint: U128(r.price_at_mint),
        minted_at_ms: U64(r.minted_at / 1_000_000),
        stats: r.stats.clone(),
        listing: r.listing.as_ref().map(|l| listing_view(token_id, l)),
        transfer_call_pending: r.transfer_call_pending,
    }
}

#[near]
impl Deed {
    /// sha256 of the vault code that every new vault runs. Compare with the code hash of any
    /// `<slug>.<deed account>` on an explorer.
    pub fn vault_code_hash(&self) -> VaultCodeHash {
        let hash = env::sha256(VAULT_WASM);
        VaultCodeHash {
            sha256_hex: hash.iter().map(|b| format!("{b:02x}")).collect(),
            sha256_base58: bs58::encode(&hash).into_string(),
            size_bytes: VAULT_WASM.len() as u32,
        }
    }

    pub fn get_config(&self) -> DeedConfig {
        DeedConfig {
            admin_id: self.admin_id.clone(),
            payment_token: self.payment_token.clone(),
            payment_symbol: self.payment_symbol.clone(),
            mint_cost: self.mint_cost(),
            proceeds_total: U128(self.proceeds_total),
            proceeds_in_flight: U128(self.proceeds_in_flight),
        }
    }

    pub fn get_deed(&self, token_id: String) -> Option<DeedView> {
        self.tokens.get(&token_id).map(|r| deed_view(&token_id, r))
    }

    pub fn get_deeds(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<DeedView> {
        self.tokens
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .map(|(id, r)| deed_view(id, r))
            .collect()
    }

    /// Listings, active and still activating, in token order.
    pub fn get_listings(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<ListingView> {
        self.tokens
            .iter()
            .filter_map(|(id, r)| r.listing.as_ref().map(|l| listing_view(id, l)))
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(50).min(100) as usize)
            .collect()
    }

    pub fn proceeds_of(&self, account_id: AccountId) -> U128 {
        U128(self.proceeds.get(&account_id).copied().unwrap_or(0))
    }
}
