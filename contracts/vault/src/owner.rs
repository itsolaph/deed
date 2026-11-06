//! Owner powers: withdraw revenue, rotate the worker key, change config and price.
//! All of them are refused while the outlive is listed for sale.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, Allowance, NearToken, Promise, PublicKey,
};

use crate::pricing::PriceChange;
use crate::{
    events, promise_succeeded, validate_config, Vault, VaultExt, WorkerKeyRecord,
    DEFAULT_WORKER_ALLOWANCE, GAS_CALLBACK, GAS_FT_TRANSFER, MAX_WORKER_ALLOWANCE,
    WORKER_HISTORY_LEN, WORKER_METHODS,
};

#[near]
impl Vault {
    /// Sends up to `revenue` to `receiver_id` (default: the owner). A receiver lets the owner
    /// pay out to a NEAR Intents 1Click deposit address. Customer credit is never withdrawable.
    #[payable]
    pub fn withdraw(
        &mut self,
        amount: U128,
        receiver_id: Option<AccountId>,
        memo: Option<String>,
    ) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        self.assert_unlocked();
        let amount = amount.0;
        require!(amount > 0, "amount must be positive");
        require!(amount <= self.revenue, "amount exceeds withdrawable revenue");
        let receiver_id = receiver_id.unwrap_or_else(|| self.owner_id.clone());

        self.revenue -= amount;
        self.in_flight = self.in_flight.checked_add(amount).expect("in_flight overflow");

        ext_ft_core::ext(self.payment_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(receiver_id.clone(), U128(amount), memo)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw(receiver_id, U128(amount), self.owner_epoch),
            )
    }

    #[private]
    pub fn on_withdraw(&mut self, receiver_id: AccountId, amount: U128, owner_epoch: u64) -> bool {
        self.in_flight = self.in_flight.checked_sub(amount.0).expect("in_flight underflow");
        let ok = promise_succeeded();
        if ok {
            events::emit(
                "vault_withdraw",
                json!({ "receiver_id": receiver_id, "amount": amount, "owner_epoch": owner_epoch }),
            );
        } else {
            self.revenue = self.revenue.checked_add(amount.0).expect("revenue overflow");
            events::emit(
                "vault_withdraw_failed",
                json!({ "receiver_id": receiver_id, "amount": amount, "owner_epoch": owner_epoch }),
            );
        }
        ok
    }

    /// Replaces the worker key. Deletes the previous key and adds a function-call key on the
    /// vault itself that may only call `charge`, with a capped gas allowance (yoctoNEAR).
    #[payable]
    pub fn set_worker(&mut self, public_key: PublicKey, allowance: Option<U128>) -> Promise {
        assert_one_yocto();
        self.assert_owner();
        self.assert_unlocked();
        let allowance = allowance.map(|a| NearToken::from_yoctonear(a.0)).unwrap_or(DEFAULT_WORKER_ALLOWANCE);
        require!(
            !allowance.is_zero() && allowance <= MAX_WORKER_ALLOWANCE,
            "allowance must be between 1 yoctoNEAR and 5 NEAR"
        );

        let current = env::current_account_id();
        let previous = self.worker_key.replace(public_key.clone());
        self.worker_history.push(WorkerKeyRecord {
            public_key: public_key.clone(),
            set_at: env::block_timestamp(),
            owner_epoch: self.owner_epoch,
        });
        if self.worker_history.len() > WORKER_HISTORY_LEN {
            self.worker_history.remove(0);
        }

        let mut batch = Promise::new(current.clone());
        if let Some(old) = previous.clone() {
            batch = batch.delete_key(old);
        }
        batch
            .add_access_key_allowance(
                public_key.clone(),
                Allowance::limited(allowance).expect("non-zero allowance"),
                current.clone(),
                WORKER_METHODS,
            )
            .then(
                Self::ext(current)
                    .with_static_gas(GAS_CALLBACK)
                    .on_worker_set(previous, public_key, U128(allowance.as_yoctonear())),
            )
    }

    #[private]
    pub fn on_worker_set(
        &mut self,
        previous: Option<PublicKey>,
        public_key: PublicKey,
        allowance: U128,
    ) -> bool {
        let ok = promise_succeeded();
        if ok {
            events::emit(
                "vault_worker_set",
                json!({
                    "public_key": public_key,
                    "previous": previous,
                    "allowance": allowance,
                    "owner_epoch": self.owner_epoch,
                }),
            );
        } else {
            // The key batch failed as a whole, so the chain still has `previous`.
            if self.worker_key.as_ref() == Some(&public_key) {
                self.worker_key = previous;
            }
            if self.worker_history.last().is_some_and(|r| r.public_key == public_key) {
                self.worker_history.pop();
            }
            events::emit("vault_worker_set_failed", json!({ "public_key": public_key }));
        }
        ok
    }

    #[payable]
    pub fn set_config(&mut self, endpoint: String, image_hash: String) {
        assert_one_yocto();
        self.assert_owner();
        self.assert_unlocked();
        validate_config(&endpoint, &image_hash);
        self.endpoint = endpoint;
        self.image_hash = image_hash;
        events::emit(
            "vault_config",
            json!({ "endpoint": self.endpoint, "image_hash": self.image_hash }),
        );
    }

    /// A decrease applies at once. An increase applies after a 24-hour notice.
    #[payable]
    pub fn set_price(&mut self, price: U128) {
        assert_one_yocto();
        self.assert_owner();
        self.assert_unlocked();
        require!(price.0 > 0, "price must be positive");
        let now = env::block_timestamp();
        match self.price.set(price.0, now) {
            PriceChange::Unchanged => {}
            PriceChange::Immediate => events::emit(
                "vault_price",
                json!({ "price_per_call": U128(self.price.current), "effective_at_ms": now / 1_000_000 }),
            ),
            PriceChange::Scheduled { effective_at } => events::emit(
                "vault_price_scheduled",
                json!({ "price_per_call": price, "effective_at_ms": effective_at / 1_000_000 }),
            ),
        }
    }
}
