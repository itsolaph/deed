use anyhow::Result;
use serde_json::json;

use crate::common::{done, fails, has_event, item, ok, u128_of, Env, ONE_TUSDC, PRICE};

#[tokio::test]
async fn withdraw_rules() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let sk = env.set_worker(&env.seller, &vault).await?;
    let alice = env.alice.id();
    done(env.deposit(&env.alice, &vault, 5 * ONE_TUSDC, "").await?);
    let withdraw = |amount: u128| json!({ "amount": amount.to_string() });

    // Customer credit is never withdrawable: no revenue yet, so even 1 unit fails.
    fails(env.call_owner(&env.seller, &vault, "withdraw", withdraw(1)).await?, "exceeds withdrawable revenue");

    env.charge_ok(&vault, &sk, vec![item(alice, 1, 100)]).await?;
    let revenue = 100 * PRICE;

    fails(env.call_owner(&env.alice, &vault, "withdraw", withdraw(1)).await?, "only the token owner");
    fails(env.call_owner(&env.seller, &vault, "withdraw", withdraw(0)).await?, "amount must be positive");
    fails(env.call_owner(&env.seller, &vault, "withdraw", withdraw(revenue + 1)).await?, "exceeds withdrawable revenue");
    fails(
        env.seller.call(&vault, "withdraw").args_json(withdraw(1)).transact().await?,
        "Requires attached deposit of exactly 1 yoctoNEAR",
    );

    let before = env.ft_balance(env.seller.id()).await?;
    let res = ok(env.call_owner(&env.seller, &vault, "withdraw", withdraw(revenue / 2)).await?);
    assert!(has_event(&res, "vault_withdraw"));
    assert_eq!(env.ft_balance(env.seller.id()).await? - before, revenue / 2);
    env.assert_invariant(&vault).await?;

    // Paying out to an account that is not registered on the token fails and restores revenue.
    let res = ok(env
        .call_owner(&env.seller, &vault, "withdraw", json!({ "amount": (revenue / 2).to_string(), "receiver_id": env.root.id() }))
        .await?);
    assert!(has_event(&res, "vault_withdraw_failed"));
    assert!(!res.json::<bool>()?);
    assert_eq!(u128_of(&env.vault_info(&vault).await?["revenue"]), revenue / 2);
    env.assert_invariant(&vault).await?;

    // A receiver other than the owner (for example a 1Click deposit address) works.
    let bob_before = env.ft_balance(env.bob.id()).await?;
    done(env
        .call_owner(&env.seller, &vault, "withdraw", json!({ "amount": (revenue / 2).to_string(), "receiver_id": env.bob.id(), "memo": "payout" }))
        .await?);
    assert_eq!(env.ft_balance(env.bob.id()).await? - bob_before, revenue / 2);

    let info = env.vault_info(&vault).await?;
    assert_eq!(u128_of(&info["revenue"]), 0);
    assert_eq!(u128_of(&info["liabilities"]), 5 * ONE_TUSDC - revenue);
    fails(env.call_owner(&env.seller, &vault, "withdraw", withdraw(1)).await?, "exceeds withdrawable revenue");
    env.assert_invariant(&vault).await?;
    Ok(())
}

#[tokio::test]
async fn config_and_price_notice() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;

    let cfg = json!({ "endpoint": "https://b.example/v1", "image_hash": "sha256:1111" });
    fails(env.call_owner(&env.alice, &vault, "set_config", cfg.clone()).await?, "only the token owner");
    done(env.call_owner(&env.seller, &vault, "set_config", cfg).await?);
    let info = env.vault_info(&vault).await?;
    assert_eq!(info["endpoint"], "https://b.example/v1");
    assert_eq!(info["image_hash"], "sha256:1111");

    // Decrease applies at once.
    done(env.call_owner(&env.seller, &vault, "set_price", json!({ "price": (PRICE / 2).to_string() })).await?);
    assert_eq!(u128_of(&env.vault_info(&vault).await?["price_per_call"]), PRICE / 2);

    // Increase waits 24 hours.
    let res = ok(env.call_owner(&env.seller, &vault, "set_price", json!({ "price": (PRICE * 3).to_string() })).await?);
    assert!(has_event(&res, "vault_price_scheduled"));
    let info = env.vault_info(&vault).await?;
    assert_eq!(u128_of(&info["price_per_call"]), PRICE / 2);
    assert_eq!(u128_of(&info["pending_price"]), PRICE * 3);
    let at: u64 = info["price_effective_at_ms"].as_str().unwrap().parse()?;
    let created: u64 = info["created_at_ms"].as_str().unwrap().parse()?;
    assert!(at >= created + 24 * 3_600 * 1_000);

    fails(env.call_owner(&env.alice, &vault, "set_price", json!({ "price": "1" })).await?, "only the token owner");
    fails(env.call_owner(&env.seller, &vault, "set_price", json!({ "price": "0" })).await?, "price must be positive");
    Ok(())
}
