//! Customer side: deposits through ft_transfer_call, daily caps, refunds.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, NearToken, Promise, PromiseOrValue};

use crate::ledger::Customer;
use crate::{
    events, promise_succeeded, Vault, VaultExt, GAS_CALLBACK, GAS_FT_TRANSFER,
    MIN_CUSTOMER_DEPOSIT,
};

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct DepositMsg {
    deposit_for: AccountId,
}

#[near]
impl FungibleTokenReceiver for Vault {
    /// Credit for the sender (empty `msg`) or for another account
    /// (`{"deposit_for":"<account>"}`). Panics refund the whole amount through the token.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.payment_token,
            "only the payment token is accepted"
        );
        let customer_id = if msg.trim().is_empty() {
            sender_id.clone()
        } else {
            serde_json::from_str::<DepositMsg>(&msg)
                .unwrap_or_else(|_| env::panic_str("msg must be empty or {\"deposit_for\":\"<account>\"}"))
                .deposit_for
        };
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");

        let balance = match self.customers.get_mut(&customer_id) {
            Some(c) => {
                c.credit(amount).expect("balance overflow");
                c.balance
            }
            None => {
                require!(amount >= MIN_CUSTOMER_DEPOSIT, "first deposit is below the minimum");
                let mut c = Customer::new(self.default_daily_cap, self.charged_items);
                c.credit(amount).expect("balance overflow");
                self.customers.insert(customer_id.clone(), c);
                self.customer_count += 1;
                amount
            }
        };
        self.liabilities = self.liabilities.checked_add(amount).expect("liabilities overflow");

        events::emit(
            "vault_deposit",
            json!({
                "customer": customer_id,
                "sender": sender_id,
                "amount": U128(amount),
                "balance": U128(balance),
            }),
        );
        PromiseOrValue::Value(U128(0))
    }
}

#[near]
impl Vault {
    pub fn set_daily_cap(&mut self, amount: U128) {
        let id = env::predecessor_account_id();
        let c = self.customers.get_mut(&id).unwrap_or_else(|| env::panic_str("not a customer"));
        c.daily_cap = amount.0;
        events::emit("vault_daily_cap", json!({ "customer": id, "daily_cap": amount }));
    }

    /// Starts the refund delay. The worker may still charge calls it already served.
    pub fn request_refund(&mut self) {
        let id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let delay = self.refund_delay_ns;
        let c = self.customers.get_mut(&id).unwrap_or_else(|| env::panic_str("not a customer"));
        require!(c.balance > 0, "nothing to refund");
        require!(c.refund_requested_at.is_none(), "refund already requested");
        c.refund_requested_at = Some(now);
        events::emit(
            "vault_refund_requested",
            json!({
                "customer": id,
                "requested_at_ms": now / 1_000_000,
                "available_at_ms": now.saturating_add(delay) / 1_000_000,
            }),
        );
    }

    /// Pays out the whole remaining balance after the refund delay.
    pub fn claim_refund(&mut self) -> Promise {
        let id = env::predecessor_account_id();
        let now = env::block_timestamp();
        let delay = self.refund_delay_ns;
        let c = self.customers.get_mut(&id).unwrap_or_else(|| env::panic_str("not a customer"));
        let requested_at = c.refund_requested_at.unwrap_or_else(|| env::panic_str("no refund requested"));
        require!(now >= requested_at.saturating_add(delay), "refund delay has not passed");
        let amount = c.balance;
        require!(amount > 0, "nothing to refund");

        c.balance = 0;
        c.refund_requested_at = None;
        self.liabilities = self.liabilities.checked_sub(amount).expect("liabilities underflow");
        self.in_flight = self.in_flight.checked_add(amount).expect("in_flight overflow");

        ext_ft_core::ext(self.payment_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(id.clone(), U128(amount), Some("deed vault refund".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_refund(id, U128(amount), requested_at),
            )
    }

    #[private]
    pub fn on_refund(&mut self, customer: AccountId, amount: U128, requested_at: u64) -> bool {
        let amount = amount.0;
        self.in_flight = self.in_flight.checked_sub(amount).expect("in_flight underflow");
        let ok = promise_succeeded();
        if ok {
            // Free the entry when nothing is left. A deposit made meanwhile keeps it.
            let empty = self
                .customers
                .get(&customer)
                .is_some_and(|c| c.balance == 0 && c.refund_requested_at.is_none());
            if empty {
                self.customers.remove(&customer);
                self.customer_count -= 1;
            }
            events::emit(
                "vault_refund",
                json!({ "customer": customer, "amount": U128(amount), "entry_removed": empty }),
            );
        } else {
            let c = self.customers.get_mut(&customer).expect("customer entry kept until refund settles");
            c.balance = c.balance.checked_add(amount).expect("balance overflow");
            // A deposit during the failed transfer cancelled the request; otherwise restore it.
            if c.balance == amount {
                c.refund_requested_at = Some(requested_at);
            }
            self.liabilities = self.liabilities.checked_add(amount).expect("liabilities overflow");
            events::emit("vault_refund_failed", json!({ "customer": customer, "amount": U128(amount) }));
        }
        ok
    }
}
