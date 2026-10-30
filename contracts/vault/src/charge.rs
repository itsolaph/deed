//! Charging by the worker key.

use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, AccountId};

use crate::ledger::{is_hex_sha256, ChargeOutcome};
use crate::{events, Vault, VaultExt, MAX_CHARGE_ITEMS};

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct ChargeItem {
    pub customer: AccountId,
    pub seq: u64,
    pub units: u32,
    /// Hex sha256 over this batch's delivery receipts for this customer. Goes into the event only.
    pub receipts_root: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ChargeResult {
    pub customer: AccountId,
    pub seq: u64,
    pub status: String,
    pub cost: U128,
}

#[near]
impl Vault {
    /// Applies a batch of charges. Must be a transaction signed as the vault account with the
    /// registered worker key, so the predecessor is the vault itself and the signer key matches.
    /// Each item either moves `units * price` from the customer's balance to revenue or is
    /// reported with a reason and changes nothing.
    pub fn charge(&mut self, items: Vec<ChargeItem>) -> Vec<ChargeResult> {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "charge must be sent by the vault account itself"
        );
        require!(
            self.worker_key.as_ref() == Some(&env::signer_account_pk()),
            "signer key is not the registered worker key"
        );
        require!(!items.is_empty() && items.len() <= MAX_CHARGE_ITEMS, "1 to 40 items per batch");

        self.track_gas(0);
        let now = env::block_timestamp();
        let today = self.today();
        self.price.settle(now);
        let price = self.price.current;

        let mut results = Vec::with_capacity(items.len());
        let mut event_items = Vec::with_capacity(items.len());
        let mut calls: u64 = 0;
        let mut earned: u128 = 0;

        for item in items {
            let (status, cost) = if !is_hex_sha256(&item.receipts_root) {
                ("invalid_receipts_root", 0)
            } else {
                match self.customers.get_mut(&item.customer) {
                    None => ("unknown_customer", 0),
                    Some(c) => {
                        c.settle_cap(now);
                        match c.try_charge(item.seq, item.units, price, today) {
                            ChargeOutcome::Charged(cost) => ("charged", cost),
                            other => (other.as_str(), 0),
                        }
                    }
                }
            };
            if cost > 0 {
                self.liabilities = self.liabilities.checked_sub(cost).expect("liabilities underflow");
                self.revenue = self.revenue.checked_add(cost).expect("revenue overflow");
                self.charged_items += 1;
                calls += item.units as u64;
                earned += cost;
            }
            event_items.push(json!({
                "customer": item.customer,
                "seq": item.seq,
                "units": item.units,
                "cost": U128(cost),
                "status": status,
                "receipts_root": item.receipts_root,
            }));
            results.push(ChargeResult {
                customer: item.customer,
                seq: item.seq,
                status: status.to_string(),
                cost: U128(cost),
            });
        }

        if calls > 0 {
            self.stats.record_charge(today, calls, earned);
        }
        events::emit(
            "vault_charge",
            json!({ "price": U128(price), "earned": U128(earned), "items": event_items }),
        );

        if now.saturating_sub(self.last_stats_push) >= self.stats_interval_ns {
            self.push_stats_internal();
        }
        results
    }
}
