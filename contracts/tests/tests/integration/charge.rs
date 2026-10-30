use anyhow::Result;
use near_workspaces::types::{AccessKey, Gas, KeyType, SecretKey};
use near_workspaces::Account;
use serde_json::json;

use crate::common::{done, fails, has_event, item, ok, u128_of, Env, DAILY_CAP, ONE_TUSDC, PRICE};

#[tokio::test]
async fn only_the_worker_key_can_charge() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let alice = env.alice.id();
    done(env.deposit(&env.alice, &vault, 2 * ONE_TUSDC, "").await?);
    let args = json!({ "items": [item(alice, 1, 1)] });

    // No worker key registered yet: nobody can charge.
    for caller in [&env.alice, &env.seller, &env.root] {
        fails(caller.call(&vault, "charge").args_json(&args).transact().await?, "sent by the vault account");
    }
    let sk = env.set_worker(&env.seller, &vault).await?;

    // Customer, owner, and the deed account itself are all refused.
    for caller in [&env.alice, &env.seller, env.deed.as_account()] {
        fails(caller.call(&vault, "charge").args_json(&args).transact().await?, "sent by the vault account");
    }

    // A different key on the vault account (patched in, the vault never adds one) is refused.
    let other = SecretKey::from_random(KeyType::ED25519);
    env.worker.patch(&vault).access_key(other.public_key(), AccessKey::full_access()).transact().await?;
    let intruder = Account::from_secret_key(vault.clone(), other, &env.worker);
    fails(
        intruder.call(&vault, "charge").args_json(&args).gas(Gas::from_tgas(50)).transact().await?,
        "not the registered worker key",
    );

    // The worker key works and moves the price from credit to revenue.
    let res = ok(env.charge(&vault, &sk, vec![item(alice, 1, 2)]).await?);
    assert!(has_event(&res, "vault_charge"));
    let logs = res.logs().join("\n");
    assert!(logs.contains(crate::common::ROOT_HEX), "receipts_root goes into the event");
    let info = env.vault_info(&vault).await?;
    assert_eq!(u128_of(&info["revenue"]), 2 * PRICE);
    assert_eq!(u128_of(&info["liabilities"]), 2 * ONE_TUSDC - 2 * PRICE);
    env.assert_invariant(&vault).await?;

    // The worker key cannot call anything but charge.
    let worker_acc = Account::from_secret_key(vault.clone(), sk, &env.worker);
    let res = worker_acc
        .call(&vault, "withdraw")
        .args_json(json!({ "amount": "1" }))
        .gas(Gas::from_tgas(50))
        .transact()
        .await;
    assert!(res.is_err() || res.unwrap().is_failure(), "function-call key must not reach withdraw");
    Ok(())
}

#[tokio::test]
async fn seq_caps_and_balance_rules() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let sk = env.set_worker(&env.seller, &vault).await?;
    let (alice, bob) = (env.alice.id(), env.bob.id());
    done(env.deposit(&env.alice, &vault, 10 * ONE_TUSDC, "").await?);
    done(env.deposit(&env.bob, &vault, ONE_TUSDC, "").await?);

    // Replays and gaps.
    let statuses = env
        .charge_ok(&vault, &sk, vec![item(alice, 1, 1), item(alice, 1, 1), item(alice, 3, 1), item(alice, 2, 1)])
        .await?;
    assert_eq!(statuses, ["charged", "duplicate", "seq_gap", "charged"]);
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 2, 1)]).await?, ["duplicate"]);
    let c = env.customer(&vault, alice).await?;
    assert_eq!(c["last_seq"], "2");
    assert_eq!(u128_of(&c["balance"]), 10 * ONE_TUSDC - 2 * PRICE);

    // Daily cap: the default cap is 5 tUSDC, i.e. 500 calls at the test price.
    let cap_units = (DAILY_CAP / PRICE) as u32;
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 3, cap_units)]).await?, ["over_daily_cap"]);
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 3, cap_units - 2)]).await?, ["charged"]);
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 4, 1)]).await?, ["over_daily_cap"]);

    // The customer may raise their own cap.
    done(env
        .alice
        .call(&vault, "set_daily_cap")
        .args_json(json!({ "amount": (8 * ONE_TUSDC).to_string() }))
        .transact()
        .await?);
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 4, 1)]).await?, ["charged"]);
    fails(
        env.seller.call(&vault, "set_daily_cap").args_json(json!({ "amount": "1" })).transact().await?,
        "not a customer",
    );

    // Insufficient balance: bob has 1 tUSDC = 100 calls.
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(bob, 1, 101)]).await?, ["insufficient_balance"]);
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(bob, 1, 100)]).await?, ["charged"]);
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(bob, 2, 1)]).await?, ["insufficient_balance"]);

    // Unknown customers and malformed receipt roots change nothing.
    let mut bad_root = item(alice, 5, 1);
    bad_root["receipts_root"] = json!("not-hex");
    let statuses = env.charge_ok(&vault, &sk, vec![item(env.seller.id(), 1, 1), bad_root]).await?;
    assert_eq!(statuses, ["unknown_customer", "invalid_receipts_root"]);

    let info = env.vault_info(&vault).await?;
    let calls = 1 + 1 + (cap_units - 2) as u128 + 1 + 100;
    assert_eq!(u128_of(&info["revenue"]), calls * PRICE);
    let stats: serde_json::Value = env.worker.view(&vault, "get_stats").await?.json()?;
    assert_eq!(stats["calls_30d"], calls as u64);
    assert_eq!(u128_of(&stats["revenue_30d"]), calls * PRICE);
    env.assert_invariant(&vault).await?;
    Ok(())
}
