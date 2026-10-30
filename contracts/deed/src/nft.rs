//! NEP-171 core, NEP-177 metadata (built on the fly) and NEP-181 enumeration.
//! There is no NEP-178 approval management: the built-in sale is the only sale path.

use std::collections::HashMap;

use near_contract_standards::non_fungible_token::core::ext_nft_receiver;
use near_contract_standards::non_fungible_token::events::NftTransfer;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::Token;
use near_sdk::json_types::U128;
use near_sdk::serde_json;
use near_sdk::{assert_one_yocto, env, near, require, AccountId, PromiseOrValue};

use crate::svg::{self, Certificate, TOKEN_DECIMALS};
use crate::{Deed, DeedExt, TokenRecord, GAS_RESOLVE_TRANSFER};

const DEFAULT_PAGE: u64 = 50;
const MAX_PAGE: u64 = 100;

const CONTRACT_ICON: &str = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiBmaWxsPSIjZjNlYWQzIi8+PHJlY3QgeD0iNiIgeT0iNiIgd2lkdGg9IjUyIiBoZWlnaHQ9IjUyIiBmaWxsPSJub25lIiBzdHJva2U9IiMxZjFjMTciIHN0cm9rZS13aWR0aD0iMyIvPjxjaXJjbGUgY3g9IjMyIiBjeT0iMzIiIHI9IjEzIiBmaWxsPSIjN2ExZjFmIi8+PC9zdmc+";

impl Deed {
    pub(crate) fn render_metadata(&self, token_id: &str, r: &TokenRecord) -> TokenMetadata {
        let stats = r.stats.clone().unwrap_or_default();
        let price = if r.stats.is_some() { stats.price_per_call.0 } else { r.price_at_mint };
        let cert = Certificate {
            title: &r.title,
            token_id,
            vault_id: r.vault_id.as_str(),
            owner_id: r.owner_id.as_str(),
            owner_epoch: r.owner_epoch,
            symbol: &self.payment_symbol,
            price_per_call: price,
            calls_30d: stats.calls_30d,
            revenue_30d: stats.revenue_30d.0,
            cash: stats.cash.0,
            liabilities: stats.liabilities.0,
            updated_at_ms: r.stats.as_ref().map(|s| s.updated_at_ms),
        };
        let amount = |v: u128| format!("{} {}", svg::format_amount(v, TOKEN_DECIMALS), self.payment_symbol);
        let description = format!(
            "Deed to the business \"{}\". Its vault {} holds the treasury, price list, customer \
             ledger and worker key. Price per call {}. Last 30 days: {} calls, {} revenue. Cash in vault {}.",
            r.title,
            r.vault_id,
            amount(price),
            svg::format_count(stats.calls_30d),
            amount(stats.revenue_30d.0),
            amount(stats.cash.0),
        );
        TokenMetadata {
            title: Some(r.title.clone()),
            description: Some(description),
            media: Some(svg::data_uri(&svg::render(&cert))),
            media_hash: None,
            copies: Some(1),
            issued_at: Some((r.minted_at / 1_000_000).to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: r.stats.as_ref().map(|s| s.updated_at_ms.to_string()),
            extra: r.stats.as_ref().map(|s| serde_json::to_string(s).expect("stats json")),
            reference: None,
            reference_hash: None,
        }
    }

    pub(crate) fn to_token(&self, token_id: &str, r: &TokenRecord) -> Token {
        Token {
            token_id: token_id.to_string(),
            owner_id: r.owner_id.clone(),
            metadata: Some(self.render_metadata(token_id, r)),
            approved_account_ids: None,
        }
    }

    /// Moves the token in the registry. Callers push the owner to the vault when the change is final.
    pub(crate) fn move_token(&mut self, token_id: &str, from: &AccountId, to: &AccountId, memo: Option<&str>) {
        self.token_mut(token_id).owner_id = to.clone();
        if let Some(list) = self.owner_tokens.get_mut(from) {
            list.retain(|t| t != token_id);
            if list.is_empty() {
                self.owner_tokens.remove(from);
            }
        }
        self.owner_tokens.entry(to.clone()).or_default().push(token_id.to_string());
        NftTransfer {
            old_owner_id: from,
            new_owner_id: to,
            token_ids: &[token_id],
            authorized_id: None,
            memo,
        }
        .emit();
    }

    fn assert_transferable(&self, token_id: &str, sender: &AccountId, receiver: &AccountId, approval_id: Option<u64>) {
        require!(approval_id.is_none(), "approvals are not supported");
        let r = self.token(token_id);
        require!(&r.owner_id == sender, "only the token owner may transfer");
        require!(sender != receiver, "sender and receiver must differ");
        require!(r.listing.is_none(), "token is listed; cancel the listing first");
    }
}

#[near]
impl Deed {
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.assert_transferable(&token_id, &sender, &receiver_id, approval_id);
        self.move_token(&token_id, &sender, &receiver_id, memo.as_deref());
        self.finalize_owner(&token_id).detach();
    }

    /// The owner change is pushed to the vault only in `nft_resolve_transfer`, once the final
    /// owner is known.
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_one_yocto();
        let sender = env::predecessor_account_id();
        self.assert_transferable(&token_id, &sender, &receiver_id, approval_id);
        require!(!self.token(&token_id).transfer_call_pending, "a transfer call is already pending");
        self.move_token(&token_id, &sender, &receiver_id, memo.as_deref());
        self.token_mut(&token_id).transfer_call_pending = true;

        ext_nft_receiver::ext(receiver_id.clone())
            .with_unused_gas_weight(1)
            .nft_on_transfer(sender.clone(), sender.clone(), token_id.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .nft_resolve_transfer(sender, receiver_id, token_id, None),
            )
            .into()
    }

    /// Returns true if the token ended with `receiver_id` (or was moved on by it).
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        #[allow(unused_variables)] approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        let must_revert = env::promise_result_checked(0, "false".len())
            .ok()
            .and_then(|v| serde_json::from_slice::<bool>(&v).ok())
            .unwrap_or(true);
        let record = self.token_mut(&token_id);
        record.transfer_call_pending = false;
        if record.owner_id != receiver_id {
            // The receiver already transferred it on; that transfer pushed its own owner.
            return true;
        }
        if !must_revert {
            self.finalize_owner(&token_id).detach();
            return true;
        }
        self.move_token(&token_id, &receiver_id, &previous_owner_id, None);
        // The vault normally still has the previous owner, but if the receiver moved the token
        // away and back during the call, pushes happened. A fresh push is always correct.
        self.finalize_owner(&token_id).detach();
        false
    }

    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        self.tokens.get(&token_id).map(|r| self.to_token(&token_id, r))
    }

    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Deed".to_string(),
            symbol: "DEED".to_string(),
            icon: Some(CONTRACT_ICON.to_string()),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.tokens.len() as u128)
    }

    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE) as usize;
        self.tokens
            .iter()
            .skip(start)
            .take(limit)
            .map(|(id, r)| self.to_token(id, r))
            .collect()
    }

    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.owner_tokens.get(&account_id).map(|l| l.len()).unwrap_or(0) as u128)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let Some(list) = self.owner_tokens.get(&account_id) else {
            return Vec::new();
        };
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(DEFAULT_PAGE).min(MAX_PAGE) as usize;
        list.iter()
            .skip(start)
            .take(limit)
            .map(|id| self.to_token(id, self.token(id)))
            .collect()
    }
}
