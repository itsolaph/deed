//! Minting: one batch creates the vault sub-account, funds it, deploys the vault code and
//! initializes it. The token exists only after that batch succeeded.

use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::storage_management::ext_storage_management;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::slug::{validate_slug, validate_title};
use crate::{
    events, promise_succeeded, Deed, DeedExt, TokenRecord, FT_STORAGE_DEPOSIT, GAS_ON_VAULT_CREATED,
    GAS_STORAGE_DEPOSIT, GAS_VAULT_NEW, TOKEN_STORAGE_RESERVE, VAULT_GAS_TANK, VAULT_STATE_RESERVE,
    VAULT_WASM,
};

/// Same limits as the vault, checked here so a bad mint fails before any account is created.
const MAX_ENDPOINT_LEN: usize = 256;
const MAX_IMAGE_HASH_LEN: usize = 128;

impl Deed {
    /// NEAR sent to the new vault account: code storage, state and the starting gas tank.
    pub(crate) fn vault_funding() -> NearToken {
        env::storage_byte_cost()
            .saturating_mul(VAULT_WASM.len() as u128)
            .saturating_add(VAULT_STATE_RESERVE)
            .saturating_add(VAULT_GAS_TANK)
    }
}

#[near]
impl Deed {
    /// Deposit that `mint` needs. Anything above it is refunded.
    pub fn mint_cost(&self) -> NearToken {
        Self::vault_funding()
            .saturating_add(TOKEN_STORAGE_RESERVE)
            .saturating_add(FT_STORAGE_DEPOSIT)
    }

    #[payable]
    pub fn mint(
        &mut self,
        slug: String,
        title: String,
        price_per_call: U128,
        endpoint: String,
        image_hash: String,
        default_daily_cap: U128,
    ) -> Promise {
        let minter = env::predecessor_account_id();
        let current = env::current_account_id();
        validate_slug(&slug, current.as_str()).unwrap_or_else(|e| env::panic_str(e));
        validate_title(&title).unwrap_or_else(|e| env::panic_str(e));
        require!(price_per_call.0 > 0, "price must be positive");
        require!(endpoint.len() <= MAX_ENDPOINT_LEN, "endpoint too long");
        require!(image_hash.len() <= MAX_IMAGE_HASH_LEN, "image_hash too long");
        require!(
            !self.tokens.contains_key(&slug) && !self.pending_mints.contains_key(&slug),
            "slug is taken"
        );
        let deposit = env::attached_deposit();
        let cost = self.mint_cost();
        require!(deposit >= cost, format!("attach at least {} yoctoNEAR (mint_cost)", cost.as_yoctonear()));

        self.pending_mints.insert(slug.clone(), minter.clone());

        let vault_id: AccountId = format!("{slug}.{current}").parse().expect("valid vault account id");
        let init_args = serde_json::to_vec(&json!({
            "token_id": slug,
            "owner_id": minter,
            "payment_token": self.payment_token,
            "price_per_call": price_per_call,
            "endpoint": endpoint,
            "image_hash": image_hash,
            "default_daily_cap": default_daily_cap,
        }))
        .expect("init args");

        Promise::new(vault_id)
            .create_account()
            .transfer(Self::vault_funding())
            .deploy_contract(VAULT_WASM.to_vec())
            .function_call("new", init_args, NearToken::from_yoctonear(0), GAS_VAULT_NEW)
            .then(
                Self::ext(current)
                    .with_static_gas(GAS_ON_VAULT_CREATED)
                    .on_vault_created(slug, minter, title, price_per_call, deposit, cost),
            )
    }

    #[private]
    pub fn on_vault_created(
        &mut self,
        slug: String,
        minter: AccountId,
        title: String,
        price_per_call: U128,
        deposit: NearToken,
        cost: NearToken,
    ) -> bool {
        self.pending_mints.remove(&slug);
        let vault_id: AccountId =
            format!("{slug}.{}", env::current_account_id()).parse().expect("valid vault account id");

        if !promise_succeeded() {
            // The batch reverted as a whole: no account, no code, and its NEAR comes back to
            // the deed. Return the full deposit to the minter.
            Promise::new(minter.clone()).transfer(deposit).detach();
            events::emit(
                "deed_mint_failed",
                json!({ "token_id": slug, "minter": minter, "refunded": deposit }),
            );
            return false;
        }

        self.tokens.insert(
            slug.clone(),
            TokenRecord {
                owner_id: minter.clone(),
                owner_epoch: 1,
                vault_id: vault_id.clone(),
                title,
                price_at_mint: price_per_call.0,
                minted_at: env::block_timestamp(),
                stats: None,
                listing: None,
                last_listing_id: 0,
                transfer_call_pending: false,
            },
        );
        self.owner_tokens.entry(minter.clone()).or_default().push(slug.clone());
        NftMint { owner_id: &minter, token_ids: &[&slug], memo: None }.emit();
        events::emit(
            "deed_vault_created",
            json!({ "token_id": slug, "vault_id": vault_id, "owner_id": minter, "owner_epoch": 1 }),
        );

        ext_storage_management::ext(self.payment_token.clone())
            .with_attached_deposit(FT_STORAGE_DEPOSIT)
            .with_static_gas(GAS_STORAGE_DEPOSIT)
            .storage_deposit(Some(vault_id), Some(true))
            .detach();

        let excess = deposit.saturating_sub(cost);
        if !excess.is_zero() {
            Promise::new(minter).transfer(excess).detach();
        }
        true
    }
}
