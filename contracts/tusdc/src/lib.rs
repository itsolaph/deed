//! Test USDC (tUSDC): a testnet-only NEP-141 token with NEP-145 storage and NEP-148 metadata.
//! Anyone may mint up to 1,000 tUSDC per call to themselves. It has no value. Never deploy it
//! on mainnet.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::events::FtMint;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, PromiseOrValue};

pub const DECIMALS: u8 = 6;
/// 1,000 tUSDC per mint call.
pub const MAX_MINT_PER_CALL: u128 = 1_000 * 1_000_000;

const ICON: &str = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PGNpcmNsZSBjeD0iMzIiIGN5PSIzMiIgcj0iMzAiIGZpbGw9IiMyNzc1Y2EiLz48dGV4dCB4PSIzMiIgeT0iNDAiIGZvbnQtc2l6ZT0iMjIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZpbGw9IiNmZmYiIGZvbnQtZmFtaWx5PSJzYW5zLXNlcmlmIj50PC90ZXh0Pjwvc3ZnPg==";

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct TestUsdc {
    token: FungibleToken,
}

#[near]
impl TestUsdc {
    #[init]
    #[private]
    pub fn new() -> Self {
        Self { token: FungibleToken::new(b"t".to_vec()) }
    }

    /// Mints `amount` (smallest units, 6 decimals) to the caller. The caller must be
    /// registered with `storage_deposit` first.
    pub fn mint(&mut self, amount: U128) {
        let account = env::predecessor_account_id();
        require!(amount.0 > 0 && amount.0 <= MAX_MINT_PER_CALL, "mint 1 unit to 1,000 tUSDC per call");
        require!(self.token.accounts.contains_key(&account), "register with storage_deposit first");
        self.token.internal_deposit(&account, amount.0);
        FtMint { owner_id: &account, amount, memo: Some("faucet") }.emit();
    }
}

#[near]
impl FungibleTokenCore for TestUsdc {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for TestUsdc {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        let (used, _burned) = self.token.internal_ft_resolve_transfer(&sender_id, receiver_id, amount);
        used.into()
    }
}

#[near]
impl StorageManagement for TestUsdc {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for TestUsdc {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "Test USDC".to_string(),
            symbol: "tUSDC".to_string(),
            icon: Some(ICON.to_string()),
            reference: None,
            reference_hash: None,
            decimals: DECIMALS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    fn setup() -> TestUsdc {
        let mut ctx = VMContextBuilder::new();
        ctx.predecessor_account_id(accounts(0)).attached_deposit(NearToken::from_millinear(10));
        testing_env!(ctx.build());
        let mut t = TestUsdc::new();
        t.storage_deposit(None, Some(true));
        t
    }

    #[test]
    fn mint_up_to_cap() {
        let mut t = setup();
        t.mint(U128(MAX_MINT_PER_CALL));
        t.mint(U128(1));
        assert_eq!(t.ft_balance_of(accounts(0)).0, MAX_MINT_PER_CALL + 1);
        assert_eq!(t.ft_total_supply().0, MAX_MINT_PER_CALL + 1);
    }

    #[test]
    #[should_panic(expected = "per call")]
    fn mint_over_cap_fails() {
        setup().mint(U128(MAX_MINT_PER_CALL + 1));
    }

    #[test]
    #[should_panic(expected = "register")]
    fn mint_unregistered_fails() {
        let mut t = setup();
        let mut ctx = VMContextBuilder::new();
        ctx.predecessor_account_id(accounts(1));
        testing_env!(ctx.build());
        t.mint(U128(1));
    }

    #[test]
    fn metadata() {
        let t = setup();
        let m = t.ft_metadata();
        assert_eq!((m.symbol.as_str(), m.decimals, m.name.as_str()), ("tUSDC", 6, "Test USDC"));
    }
}
