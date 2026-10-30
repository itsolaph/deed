//! Pushing the owner to the vault, and stats coming back from the vault.

use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, NearToken, Promise};

use crate::{
    events, promise_succeeded, Deed, DeedExt, VaultStats, GAS_ON_OWNER_PUSHED, GAS_SET_OWNER,
};

#[allow(dead_code)]
#[ext_contract(ext_vault)]
pub trait VaultHooks {
    fn set_owner(&mut self, new_owner: AccountId, epoch: u64) -> bool;
    fn lock(&mut self, epoch: u64);
    fn unlock(&mut self, epoch: u64) -> bool;
}

impl Deed {
    /// Ends an ownership change: bump the token's epoch and push owner and epoch to the vault.
    pub(crate) fn finalize_owner(&mut self, token_id: &str) -> Promise {
        let record = self.token_mut(token_id);
        record.owner_epoch += 1;
        let (vault, owner, epoch) = (record.vault_id.clone(), record.owner_id.clone(), record.owner_epoch);
        Self::push_owner(token_id, vault, owner, epoch, NearToken::from_yoctonear(0))
    }

    fn push_owner(token_id: &str, vault: AccountId, owner: AccountId, epoch: u64, deposit: NearToken) -> Promise {
        ext_vault::ext(vault)
            .with_static_gas(GAS_SET_OWNER)
            .with_attached_deposit(deposit)
            .set_owner(owner.clone(), epoch)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_OWNER_PUSHED)
                    .on_owner_pushed(token_id.to_string(), owner, epoch),
            )
    }
}

#[near]
impl Deed {
    /// Anyone may re-push the current owner and epoch, for example after a push ran out of gas.
    /// An attached deposit is forwarded to the vault (for its storage).
    #[payable]
    pub fn sync_vault(&mut self, token_id: String) -> Promise {
        let r = self.token(&token_id);
        Self::push_owner(&token_id, r.vault_id.clone(), r.owner_id.clone(), r.owner_epoch, env::attached_deposit())
    }

    #[private]
    pub fn on_owner_pushed(&mut self, token_id: String, owner_id: AccountId, epoch: u64) -> bool {
        let ok = promise_succeeded();
        let event = if ok { "deed_owner_pushed" } else { "deed_owner_push_failed" };
        events::emit(event, json!({ "token_id": token_id, "owner_id": owner_id, "epoch": epoch }));
        ok
    }

    /// Accepted only from the token's own vault account.
    pub fn on_stats(&mut self, token_id: String, stats: VaultStats) {
        let record = self.token_mut(&token_id);
        require!(env::predecessor_account_id() == record.vault_id, "only the token's vault");
        record.stats = Some(stats.clone());
        events::emit("deed_stats", json!({ "token_id": token_id, "stats": stats }));
    }
}
