use anyhow::Result;
use near_workspaces::types::{KeyType, SecretKey};
use serde_json::{json, Value};

use crate::common::{done, fails, has_event, item, ok, u128_of, Env, MAX_GAS, ONE_TUSDC, PRICE};

const SALE_PRICE: u128 = 50 * ONE_TUSDC;

#[tokio::test]
async fn listing_locks_owner_actions_and_cancel_unlocks() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let sk = env.set_worker(&env.seller, &vault).await?;
    let alice = env.alice.id();
    done(env.deposit(&env.alice, &vault, 5 * ONE_TUSDC, "").await?);
    env.charge_ok(&vault, &sk, vec![item(alice, 1, 10)]).await?;

    fails(env.list(&env.alice, "relay", SALE_PRICE).await?, "only the token owner");
    let res = ok(env.list(&env.seller, "relay", SALE_PRICE).await?);
    assert!(has_event(&res, "outlive_listed") && has_event(&res, "outlive_listing_active"));
    assert!(res.json::<bool>()?);
    let outlive = env.outlive_view("relay").await?;
    assert_eq!(outlive["listing"]["active"], true);
    assert_eq!(u128_of(&outlive["listing"]["price"]), SALE_PRICE);
    assert_eq!(env.vault_info(&vault).await?["locked"], true);
    fails(env.list(&env.seller, "relay", SALE_PRICE).await?, "already listed");

    // While listed the seller cannot drain, rotate, reconfigure or reprice the vault.
    let locked = "locked while the outlive is listed";
    fails(env.call_owner(&env.seller, &vault, "withdraw", json!({ "amount": "1" })).await?, locked);
    let new_key = SecretKey::from_random(KeyType::ED25519).public_key().to_string();
    fails(env.call_owner(&env.seller, &vault, "set_worker", json!({ "public_key": new_key })).await?, locked);
    fails(
        env.call_owner(&env.seller, &vault, "set_config", json!({ "endpoint": "x", "image_hash": "y" })).await?,
        locked,
    );
    fails(env.call_owner(&env.seller, &vault, "set_price", json!({ "price": "1" })).await?, locked);
    fails(env.transfer(&env.seller, env.bob.id(), "relay").await?, "token is listed");

    // Customers keep being served and charged during the listing.
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 2, 1)]).await?, ["charged"]);

    let cancel = |who: &near_workspaces::Account| {
        who.call(env.outlive.id(), "cancel_listing")
            .args_json(json!({ "token_id": "relay" }))
            .deposit(near_workspaces::types::NearToken::from_yoctonear(1))
            .gas(MAX_GAS)
            .transact()
    };
    fails(cancel(&env.alice).await?, "only the seller");
    let res = ok(cancel(&env.seller).await?);
    assert!(has_event(&res, "outlive_listing_cancelled") && has_event(&res, "vault_unlock"));
    assert_eq!(env.vault_info(&vault).await?["locked"], false);
    assert!(env.outlive_view("relay").await?["listing"].is_null());
    done(env.call_owner(&env.seller, &vault, "withdraw", json!({ "amount": PRICE.to_string() })).await?);
    env.assert_invariant(&vault).await?;
    Ok(())
}

#[tokio::test]
async fn buy_moves_the_business_and_rotation_hands_over_the_worker() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let old_key = env.set_worker(&env.seller, &vault).await?;
    let alice = env.alice.id();
    done(env.deposit(&env.alice, &vault, 5 * ONE_TUSDC, "").await?);
    env.charge_ok(&vault, &old_key, vec![item(alice, 1, 10)]).await?;
    done(env.list(&env.seller, "relay", SALE_PRICE).await?);

    let buyer_start = env.ft_balance(env.buyer.id()).await?;
    let seller_start = env.ft_balance(env.seller.id()).await?;

    // Refusals return everything: max_price too low, too little sent, unknown token.
    for (amount, max_price, token) in [
        (SALE_PRICE, SALE_PRICE - 1, "relay"),
        (SALE_PRICE - 1, SALE_PRICE, "relay"),
        (SALE_PRICE, SALE_PRICE, "nope"),
    ] {
        let res = ok(env.buy(&env.buyer, token, amount, max_price).await?);
        assert!(has_event(&res, "outlive_buy_refused"));
        assert_eq!(res.json::<String>()?, "0", "nothing used");
    }
    assert_eq!(env.ft_balance(env.buyer.id()).await?, buyer_start);
    assert_eq!(env.outlive_view("relay").await?["listing"]["active"], true);

    // Buy with 7 tUSDC too much: the excess comes back, the seller gets the price.
    let res = ok(env.buy(&env.buyer, "relay", SALE_PRICE + 7 * ONE_TUSDC, SALE_PRICE).await?);
    assert!(has_event(&res, "outlive_sold") && has_event(&res, "nft_transfer") && has_event(&res, "vault_owner"));
    assert!(has_event(&res, "outlive_seller_paid"));
    assert_eq!(res.json::<String>()?, SALE_PRICE.to_string());
    assert_eq!(buyer_start - env.ft_balance(env.buyer.id()).await?, SALE_PRICE);
    assert_eq!(env.ft_balance(env.seller.id()).await? - seller_start, SALE_PRICE);

    let token: Value = env.outlive.view("nft_token").args_json(json!({ "token_id": "relay" })).await?.json()?;
    assert_eq!(token["owner_id"], env.buyer.id().as_str());
    let info = env.vault_info(&vault).await?;
    assert_eq!(info["owner_id"], env.buyer.id().as_str());
    assert_eq!(info["owner_epoch"], 2);
    assert_eq!(info["locked"], false);
    assert!(env.outlive_view("relay").await?["listing"].is_null());
    env.assert_outlive_invariant().await?;

    // The seller's withdraw now reverts. Revenue from the next call accrues to the buyer.
    let w = json!({ "amount": PRICE.to_string() });
    fails(env.call_owner(&env.seller, &vault, "withdraw", w.clone()).await?, "only the outlive owner");
    env.charge_ok(&vault, &old_key, vec![item(alice, 2, 5)]).await?;
    let revenue = u128_of(&env.vault_info(&vault).await?["revenue"]);
    assert_eq!(revenue, 15 * PRICE, "cash that came with the vault plus new revenue");
    let before = env.ft_balance(env.buyer.id()).await?;
    done(env.call_owner(&env.buyer, &vault, "withdraw", json!({ "amount": revenue.to_string() })).await?);
    assert_eq!(env.ft_balance(env.buyer.id()).await? - before, revenue);
    env.assert_invariant(&vault).await?;

    // Only the new owner can rotate. Rotation deletes the old key; the new one charges.
    let seller_try = SecretKey::from_random(KeyType::ED25519).public_key().to_string();
    fails(env.call_owner(&env.seller, &vault, "set_worker", json!({ "public_key": seller_try })).await?, "only the outlive owner");
    let new_key = env.set_worker(&env.buyer, &vault).await?;
    let keys = env.worker.view_access_keys(&vault).await?;
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].public_key.to_string(), new_key.public_key().to_string());
    let old = env.charge(&vault, &old_key, vec![item(alice, 3, 1)]).await;
    assert!(old.is_err() || old.unwrap().is_failure(), "old worker key must not charge");
    assert_eq!(env.charge_ok(&vault, &new_key, vec![item(alice, 3, 1)]).await?, ["charged"]);
    let history: Vec<Value> = env.worker.view(&vault, "get_worker_history").await?.json()?;
    assert_eq!(history.len(), 2);
    assert_eq!(history[1]["owner_epoch"], 2);

    // Nothing is listed any more: a second buy is refused and refunded.
    let res = ok(env.buy(&env.bob, "relay", SALE_PRICE, SALE_PRICE).await?);
    assert_eq!(res.json::<String>()?, "0");
    env.assert_invariant(&vault).await?;
    env.assert_outlive_invariant().await?;
    Ok(())
}

#[tokio::test]
async fn seller_proceeds_stay_claimable_when_unregistered() -> Result<()> {
    let env = Env::new(false).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    done(env.list(&env.seller, "relay", SALE_PRICE).await?);

    let res = ok(env.buy(&env.buyer, "relay", SALE_PRICE, SALE_PRICE).await?);
    assert!(has_event(&res, "outlive_proceeds_held"));
    let owed: Value = env.outlive.view("proceeds_of").args_json(json!({ "account_id": env.seller.id() })).await?.json()?;
    assert_eq!(u128_of(&owed), SALE_PRICE);
    assert_eq!(env.ft_balance(env.outlive.id()).await?, SALE_PRICE);
    env.assert_outlive_invariant().await?;
    assert_eq!(env.vault_info(&vault).await?["owner_id"], env.buyer.id().as_str());

    let claim = || env.seller.call(env.outlive.id(), "claim_proceeds").gas(MAX_GAS).transact();
    // Still unregistered: the payout fails and the proceeds stay put.
    let res = ok(claim().await?);
    assert!(!res.json::<bool>()?);
    env.assert_outlive_invariant().await?;
    assert_eq!(env.ft_balance(env.outlive.id()).await?, SALE_PRICE);

    env.register(env.seller.id()).await?;
    let res = ok(claim().await?);
    assert!(res.json::<bool>()?);
    assert_eq!(env.ft_balance(env.seller.id()).await?, SALE_PRICE);
    assert_eq!(env.ft_balance(env.outlive.id()).await?, 0);
    env.assert_outlive_invariant().await?;
    fails(claim().await?, "no proceeds to claim");
    Ok(())
}
