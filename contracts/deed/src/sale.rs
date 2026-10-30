//! Built-in fixed-price sale. Listing locks the vault; buying goes through `ft_transfer_call`
//! on the payment token with `msg` = `{"buy":{"token_id":"...","max_price":"..."}}`.

use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::{assert_one_yocto, env, near, require, AccountId, NearToken, Promise, PromiseOrValue};

use crate::ownership::ext_vault;
use crate::{
    events, promise_succeeded, Deed, DeedExt, Listing, GAS_CALLBACK_SMALL, GAS_FT_TRANSFER, GAS_LOCK,
    GAS_ON_LOCKED, GAS_ON_PAID,
};

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct BuyArgs {
    token_id: String,
    max_price: U128,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct BuyMsg {
    buy: BuyArgs,
}

impl Deed {
    /// Checks a purchase and returns (seller, price). Nothing is changed on error.
    fn check_buy(&self, buyer: &AccountId, amount: u128, args: &BuyArgs) -> Result<(AccountId, u128), &'static str> {
        let r = self.tokens.get(&args.token_id).ok_or("token not found")?;
        let l = r.listing.as_ref().ok_or("token is not listed")?;
        if !l.active {
            return Err("listing is not active yet");
        }
        if l.epoch != r.owner_epoch || l.seller != r.owner_id {
            return Err("listing is stale");
        }
        if r.transfer_call_pending {
            return Err("a transfer call is pending");
        }
        if &l.seller == buyer {
            return Err("seller cannot buy their own deed");
        }
        if l.price > args.max_price.0 {
            return Err("price is above max_price");
        }
        if l.price > amount {
            return Err("amount sent is below the price");
        }
        Ok((l.seller.clone(), l.price))
    }

    fn pay_seller(&self, seller: AccountId, amount: u128, token_id: String) -> Promise {
        ext_ft_core::ext(self.payment_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(seller.clone(), U128(amount), Some(format!("deed sale {token_id}")))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_ON_PAID)
                    .on_seller_paid(seller, U128(amount), token_id),
            )
    }
}

#[near]
impl Deed {
    /// Owner only. The listing becomes active once the vault confirmed the lock.
    #[payable]
    pub fn list(&mut self, token_id: String, price: U128) -> Promise {
        assert_one_yocto();
        let seller = env::predecessor_account_id();
        let r = self.token(&token_id);
        require!(r.owner_id == seller, "only the token owner may list");
        require!(r.listing.is_none(), "token is already listed");
        require!(!r.transfer_call_pending, "a transfer call is pending");
        require!(price.0 > 0, "price must be positive");
        let (vault, epoch) = (r.vault_id.clone(), r.owner_epoch);

        self.token_mut(&token_id).listing = Some(Listing {
            seller: seller.clone(),
            price: price.0,
            active: false,
            epoch,
            listed_at: env::block_timestamp(),
        });
        events::emit(
            "deed_listed",
            json!({ "token_id": token_id, "seller": seller, "price": price, "epoch": epoch }),
        );

        ext_vault::ext(vault)
            .with_static_gas(GAS_LOCK)
            .lock(epoch)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_ON_LOCKED).on_locked(token_id, epoch))
    }

    #[private]
    pub fn on_locked(&mut self, token_id: String, epoch: u64) -> bool {
        let ok = promise_succeeded();
        let record = self.token_mut(&token_id);
        let pending = record.listing.as_ref().is_some_and(|l| l.epoch == epoch && !l.active);
        if ok && pending {
            let listing = record.listing.as_mut().expect("listing");
            listing.active = true;
            let price = U128(listing.price);
            events::emit("deed_listing_active", json!({ "token_id": token_id, "price": price, "epoch": epoch }));
            return true;
        }
        if pending {
            record.listing = None;
            events::emit("deed_listing_failed", json!({ "token_id": token_id, "epoch": epoch }));
        } else if ok {
            // Locked, but the listing is gone: release the lock again.
            let vault = record.vault_id.clone();
            ext_vault::ext(vault).with_static_gas(GAS_LOCK).unlock(epoch).detach();
        }
        false
    }

    /// Seller only. Removes an active listing and unlocks the vault.
    #[payable]
    pub fn cancel_listing(&mut self, token_id: String) -> Promise {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let record = self.token_mut(&token_id);
        let listing = record.listing.as_ref().unwrap_or_else(|| env::panic_str("token is not listed"));
        require!(listing.seller == caller, "only the seller may cancel");
        require!(listing.active, "listing is still being activated; try again shortly");
        let epoch = listing.epoch;
        record.listing = None;
        let vault = record.vault_id.clone();
        events::emit("deed_listing_cancelled", json!({ "token_id": token_id, "epoch": epoch }));
        ext_vault::ext(vault).with_static_gas(GAS_LOCK).unlock(epoch)
    }

    /// Owner only, when not listed: re-sends the unlock, for example if the unlock from
    /// `cancel_listing` ran out of gas.
    #[payable]
    pub fn unlock_vault(&mut self, token_id: String) -> Promise {
        assert_one_yocto();
        let r = self.token(&token_id);
        require!(r.owner_id == env::predecessor_account_id(), "only the token owner");
        require!(r.listing.is_none(), "token is listed");
        ext_vault::ext(r.vault_id.clone()).with_static_gas(GAS_LOCK).unlock(r.owner_epoch)
    }

    #[private]
    pub fn on_seller_paid(&mut self, seller: AccountId, amount: U128, token_id: String) -> bool {
        let ok = promise_succeeded();
        if ok {
            events::emit("deed_seller_paid", json!({ "token_id": token_id, "seller": seller, "amount": amount }));
        } else {
            let owed = self.proceeds.get(&seller).copied().unwrap_or(0);
            self.proceeds.insert(seller.clone(), owed.checked_add(amount.0).expect("proceeds overflow"));
            self.proceeds_total = self.proceeds_total.checked_add(amount.0).expect("proceeds overflow");
            events::emit("deed_proceeds_held", json!({ "token_id": token_id, "seller": seller, "amount": amount }));
        }
        ok
    }

    /// Pays out sale proceeds that could not be delivered at sale time.
    pub fn claim_proceeds(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let amount = self.proceeds.remove(&account).unwrap_or(0);
        require!(amount > 0, "no proceeds to claim");
        self.proceeds_total -= amount;
        self.proceeds_in_flight = self.proceeds_in_flight.checked_add(amount).expect("overflow");
        ext_ft_core::ext(self.payment_token.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FT_TRANSFER)
            .ft_transfer(account.clone(), U128(amount), Some("deed sale proceeds".to_string()))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK_SMALL)
                    .on_proceeds_claimed(account, U128(amount)),
            )
    }

    #[private]
    pub fn on_proceeds_claimed(&mut self, account_id: AccountId, amount: U128) -> bool {
        self.proceeds_in_flight -= amount.0;
        let ok = promise_succeeded();
        if ok {
            events::emit("deed_proceeds_claimed", json!({ "account_id": account_id, "amount": amount }));
        } else {
            let owed = self.proceeds.get(&account_id).copied().unwrap_or(0);
            self.proceeds.insert(account_id, owed.checked_add(amount.0).expect("proceeds overflow"));
            self.proceeds_total = self.proceeds_total.checked_add(amount.0).expect("proceeds overflow");
        }
        ok
    }
}

#[near]
impl FungibleTokenReceiver for Deed {
    /// Buys a listed deed. Every refusal returns the whole amount to the sender.
    fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let refuse = |reason: &str| {
            events::emit(
                "deed_buy_refused",
                json!({ "buyer": sender_id, "amount": amount, "reason": reason }),
            );
            PromiseOrValue::Value(amount)
        };
        if env::predecessor_account_id() != self.payment_token {
            return refuse("wrong payment token");
        }
        let Ok(BuyMsg { buy }) = serde_json::from_str::<BuyMsg>(&msg) else {
            return refuse("msg must be {\"buy\":{\"token_id\":\"...\",\"max_price\":\"...\"}}");
        };
        let (seller, price) = match self.check_buy(&sender_id, amount.0, &buy) {
            Ok(v) => v,
            Err(reason) => return refuse(reason),
        };

        let token_id = buy.token_id;
        self.token_mut(&token_id).listing = None;
        self.move_token(&token_id, &seller, &sender_id, Some("deed sale"));
        self.finalize_owner(&token_id).detach();
        let epoch = self.token(&token_id).owner_epoch;
        events::emit(
            "deed_sold",
            json!({
                "token_id": token_id,
                "seller": seller,
                "buyer": sender_id,
                "price": U128(price),
                "epoch": epoch,
            }),
        );
        self.pay_seller(seller, price, token_id).detach();
        PromiseOrValue::Value(U128(amount.0 - price))
    }
}
