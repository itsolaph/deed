//! Calls from the outlive (ownership and sale lock), the stats push, and gas top-ups.

use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, NearToken, Promise};

use crate::{events, Vault, VaultExt, GAS_STATS_PUSH};

#[near]
impl Vault {
    /// Pushed by the outlive after every final ownership change. Epochs that are not newer than
    /// the vault's own are ignored, so pushes that arrive out of order cannot roll back the owner.
    /// A newer epoch also clears the sale lock.
    #[payable]
    pub fn set_owner(&mut self, new_owner: AccountId, epoch: u64) -> bool {
        self.assert_outlive();
        if epoch <= self.owner_epoch {
            events::emit(
                "vault_owner_ignored",
                json!({ "new_owner": new_owner, "epoch": epoch, "current_epoch": self.owner_epoch }),
            );
            return false;
        }
        let previous = std::mem::replace(&mut self.owner_id, new_owner);
        self.owner_epoch = epoch;
        let was_locked = std::mem::replace(&mut self.locked, false);
        events::emit(
            "vault_owner",
            json!({
                "previous": previous,
                "owner_id": self.owner_id,
                "epoch": epoch,
                "unlocked": was_locked,
            }),
        );
        true
    }

    /// The outlive locks the vault before a listing becomes active. The epoch must match the
    /// vault's current one, so a lock for a stale owner fails and the listing is not activated.
    /// `lock_id` is the listing id and must be newer than any lock seen before.
    pub fn lock(&mut self, epoch: u64, lock_id: u64) {
        self.assert_outlive();
        require!(epoch == self.owner_epoch, "lock epoch does not match the vault owner epoch");
        require!(lock_id > self.lock_id, "lock id is not newer than the last lock");
        self.locked = true;
        self.lock_id = lock_id;
        events::emit("vault_lock", json!({ "epoch": epoch, "lock_id": lock_id }));
    }

    /// Releases the lock only for the listing that set it.
    pub fn unlock(&mut self, epoch: u64, lock_id: u64) -> bool {
        self.assert_outlive();
        if epoch != self.owner_epoch || lock_id != self.lock_id || !self.locked {
            return false;
        }
        self.locked = false;
        events::emit("vault_unlock", json!({ "epoch": epoch, "lock_id": lock_id }));
        true
    }

    /// Anyone may push the current stats to the outlive so the NFT metadata refreshes.
    pub fn push_stats(&mut self) {
        self.push_stats_internal();
    }

    /// Adds NEAR for gas and storage. Excluded from the gas spending figures.
    #[payable]
    pub fn fund_gas(&mut self) {
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "attach NEAR to fund gas");
        self.track_gas(amount.as_yoctonear());
        events::emit(
            "vault_gas_funded",
            json!({ "from": env::predecessor_account_id(), "amount": amount }),
        );
    }
}

impl Vault {
    /// Fire and forget: a failed push never fails the caller.
    pub(crate) fn push_stats_internal(&mut self) {
        self.last_stats_push = env::block_timestamp();
        let args = serde_json::to_vec(&json!({
            "token_id": self.token_id,
            "stats": self.current_stats(),
        }))
        .expect("stats serialize");
        Promise::new(self.outlive_id.clone())
            .function_call("on_stats", args, NearToken::from_yoctonear(0), GAS_STATS_PUSH)
            .detach();
    }
}
