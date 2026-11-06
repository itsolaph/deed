//! Regression tests for the findings of the Phase R self-review (see docs/SECURITY.md).
//! Each of them failed before the matching fix.

use anyhow::Result;
use near_workspaces::types::NearToken;
use near_workspaces::Account;
use serde_json::{json, Value};

use crate::common::{done, fails, has_event, item, ok, u128_of, Env, MAX_GAS, ONE_TUSDC, PRICE};
use crate::integration::customers::advance_time;

const SALE_PRICE: u128 = 50 * ONE_TUSDC;

/// H-1: a deposit by someone else used to cancel a pending refund request, so anyone could
/// keep a customer from ever leaving for 1 unit of the token per refund delay.
#[tokio::test]
async fn third_party_deposit_does_not_cancel_a_refund_request() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let alice = env.alice.id();
    done(env.deposit(&env.alice, &vault, 2 * ONE_TUSDC, "").await?);
    done(env.alice.call(&vault, "request_refund").gas(MAX_GAS).transact().await?);

    let for_alice = json!({ "deposit_for": alice }).to_string();
    done(env.deposit(&env.bob, &vault, 1, &for_alice).await?);
    let c = env.customer(&vault, alice).await?;
    assert!(!c["refund_requested_at_ms"].is_null(), "a third-party deposit must not cancel the request");
    assert_eq!(u128_of(&c["balance"]), 2 * ONE_TUSDC + 1);

    advance_time(&env, 601).await?;
    let before = env.ft_balance(alice).await?;
    let res = ok(env.alice.call(&vault, "claim_refund").gas(MAX_GAS).transact().await?);
    assert!(res.json::<bool>()?);
    assert_eq!(env.ft_balance(alice).await? - before, 2 * ONE_TUSDC + 1, "the gift is refunded too");
    env.assert_invariant(&vault).await?;
    Ok(())
}

/// M-1: lowering the daily cap used to apply at once, so a customer could block charges for
/// calls already served and then take a refund.
#[tokio::test]
async fn cap_decrease_waits_for_the_refund_delay() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let sk = env.set_worker(&env.seller, &vault).await?;
    let alice = env.alice.id();
    done(env.deposit(&env.alice, &vault, 5 * ONE_TUSDC, "").await?);
    let set_cap = |amount: u128| {
        env.alice.call(&vault, "set_daily_cap").args_json(json!({ "amount": amount.to_string() })).transact()
    };

    let res = ok(set_cap(0).await?);
    assert!(has_event(&res, "vault_daily_cap_scheduled"));
    let c = env.customer(&vault, alice).await?;
    assert_eq!(u128_of(&c["daily_cap"]), crate::common::DAILY_CAP, "old cap still applies");
    assert_eq!(u128_of(&c["pending_daily_cap"]), 0);
    assert!(!c["daily_cap_effective_at_ms"].is_null());

    // Calls served before the change can still be charged during the delay.
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 1, 3)]).await?, ["charged"]);

    advance_time(&env, 601).await?;
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 2, 1)]).await?, ["over_daily_cap"]);
    let c = env.customer(&vault, alice).await?;
    assert_eq!(u128_of(&c["daily_cap"]), 0);
    assert!(c["pending_daily_cap"].is_null());

    // Raising the cap applies at once.
    done(set_cap(ONE_TUSDC).await?);
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 2, 1)]).await?, ["charged"]);
    env.assert_invariant(&vault).await?;
    Ok(())
}

async fn buy_listing(env: &Env, buyer: &Account, listing_id: &Value) -> Result<near_workspaces::result::ExecutionFinalResult> {
    let msg = json!({
        "buy": { "token_id": "relay", "max_price": SALE_PRICE.to_string(), "listing_id": listing_id }
    })
    .to_string();
    Ok(buyer
        .call(env.tusdc.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": env.outlive.id(), "amount": SALE_PRICE.to_string(), "msg": msg }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?)
}

/// M-2: a seller could cancel, withdraw the vault's cash and re-list at the same price while a
/// buyer's purchase was on its way. A buyer can now pin the listing it evaluated.
#[tokio::test]
async fn buyer_can_pin_the_listing_it_evaluated() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let sk = env.set_worker(&env.seller, &vault).await?;
    done(env.deposit(&env.alice, &vault, 5 * ONE_TUSDC, "").await?);
    env.charge_ok(&vault, &sk, vec![item(env.alice.id(), 1, 10)]).await?;

    done(env.list(&env.seller, "relay", SALE_PRICE).await?);
    let seen = env.outlive_view("relay").await?["listing"]["listing_id"].clone();
    assert!(seen.is_number(), "listing has an id: {seen}");
    assert_eq!(env.vault_info(&vault).await?["lock_id"], seen);

    // The seller pulls the cash and re-lists at the same price.
    let cancel = env
        .seller
        .call(env.outlive.id(), "cancel_listing")
        .args_json(json!({ "token_id": "relay" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?;
    done(cancel);
    let cash = u128_of(&env.vault_info(&vault).await?["revenue"]);
    done(env.call_owner(&env.seller, &vault, "withdraw", json!({ "amount": cash.to_string() })).await?);
    done(env.list(&env.seller, "relay", SALE_PRICE).await?);
    let relisted = env.outlive_view("relay").await?["listing"]["listing_id"].clone();
    assert_ne!(relisted, seen);

    // The buy for the listing the buyer evaluated is refused and refunded in full.
    let start = env.ft_balance(env.buyer.id()).await?;
    let res = ok(buy_listing(&env, &env.buyer, &seen).await?);
    assert!(has_event(&res, "outlive_buy_refused"));
    assert_eq!(res.json::<String>()?, "0");
    assert_eq!(env.ft_balance(env.buyer.id()).await?, start);

    // A buy pinned to the current listing goes through.
    let res = ok(buy_listing(&env, &env.buyer, &relisted).await?);
    assert!(has_event(&res, "outlive_sold"));
    assert_eq!(env.vault_info(&vault).await?["owner_id"], env.buyer.id().as_str());
    env.assert_invariant(&vault).await?;
    env.assert_outlive_invariant().await?;
    Ok(())
}

/// M-2 (ordering): lock and unlock carry the listing id, so a stale unlock or lock that
/// arrives late can neither unlock a vault with an active listing nor re-lock it.
#[tokio::test]
async fn stale_lock_ids_are_ignored() -> Result<()> {
    let env = Env::new(true).await?;
    let fake_outlive = env
        .root
        .create_subaccount("fakeoutlive")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let v = fake_outlive
        .create_subaccount("v")
        .initial_balance(NearToken::from_near(4))
        .transact()
        .await?
        .into_result()?
        .deploy(&Env::vault_wasm()?)
        .await?
        .into_result()?;
    done(fake_outlive
        .call(v.id(), "new")
        .args_json(json!({
            "token_id": "t1",
            "owner_id": env.seller.id(),
            "payment_token": env.tusdc.id(),
            "price_per_call": PRICE.to_string(),
            "endpoint": "",
            "image_hash": "",
            "default_daily_cap": "1000000",
        }))
        .transact()
        .await?);
    let hook = |method: &'static str, lock_id: u64| {
        fake_outlive.call(v.id(), method).args_json(json!({ "epoch": 1, "lock_id": lock_id })).transact()
    };
    let locked = || async { Ok::<Value, anyhow::Error>(v.view("get_info").await?.json::<Value>()?["locked"].clone()) };

    done(hook("lock", 2).await?);
    // An unlock left over from an older listing does not release the newer lock.
    assert!(!ok(hook("unlock", 1).await?).json::<bool>()?);
    assert_eq!(locked().await?, true);
    // An older lock arriving late is refused.
    fails(hook("lock", 1).await?, "lock id is not newer");
    assert!(ok(hook("unlock", 2).await?).json::<bool>()?);
    assert_eq!(locked().await?, false);
    // A lock id is used once.
    fails(hook("lock", 2).await?, "lock id is not newer");
    assert_eq!(locked().await?, false);
    Ok(())
}

/// Low findings: transfers to the token's own vault are refused, and an `nft_transfer_call`
/// to an account without a receiver contract returns the token and keeps the vault in sync.
#[tokio::test]
async fn transfer_edge_cases() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    fails(env.transfer(&env.seller, &vault, "relay").await?, "cannot receive");
    fails(env.transfer(&env.seller, env.outlive.id(), "relay").await?, "cannot receive");

    let res = ok(env
        .seller
        .call(env.outlive.id(), "nft_transfer_call")
        .args_json(json!({ "receiver_id": env.alice.id(), "token_id": "relay", "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?);
    assert!(!res.json::<bool>()?, "receiver has no contract, so the transfer reverts");
    let outlive = env.outlive_view("relay").await?;
    assert_eq!(outlive["owner_id"], env.seller.id().as_str());
    assert_eq!(outlive["transfer_call_pending"], false);
    let info = env.vault_info(&vault).await?;
    assert_eq!(info["owner_id"], env.seller.id().as_str());
    assert_eq!(info["owner_epoch"], outlive["owner_epoch"]);
    Ok(())
}
