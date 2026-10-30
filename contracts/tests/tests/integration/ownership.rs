use anyhow::Result;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

use crate::common::{done, fails, has_event, ok, Env, MAX_GAS, PRICE};

#[tokio::test]
async fn quick_transfers_end_with_the_right_owner() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;

    // Second transfer is sent as soon as the first one changed the deed, while the first
    // push to the vault may still be in flight. The epoch rule keeps the final owner.
    let first = env
        .seller
        .call(env.deed.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": env.alice.id(), "token_id": "relay" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact_async()
        .await?;
    loop {
        let t: Value = env.deed.view("nft_token").args_json(json!({ "token_id": "relay" })).await?.json()?;
        if t["owner_id"] == env.alice.id().as_str() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    done(env.transfer(&env.alice, env.bob.id(), "relay").await?);
    let first = first.await?;
    assert!(first.is_success());

    let info = env.vault_info(&vault).await?;
    assert_eq!(info["owner_id"], env.bob.id().as_str());
    assert_eq!(info["owner_epoch"], 3);
    let deed = env.deed_view("relay").await?;
    assert_eq!(deed["owner_epoch"], 3);
    assert_eq!(deed["owner_id"], env.bob.id().as_str());

    // NEP-171 bookkeeping follows.
    let supply = |id: &near_workspaces::AccountId| {
        env.deed.view("nft_supply_for_owner").args_json(json!({ "account_id": id }))
    };
    assert_eq!(supply(env.seller.id()).await?.json::<String>()?, "0");
    assert_eq!(supply(env.bob.id()).await?.json::<String>()?, "1");

    // Plain transfer rules.
    fails(env.transfer(&env.alice, env.seller.id(), "relay").await?, "only the token owner");
    fails(env.transfer(&env.bob, env.bob.id(), "relay").await?, "sender and receiver must differ");
    fails(
        env.bob
            .call(env.deed.id(), "nft_transfer")
            .args_json(json!({ "receiver_id": env.alice.id(), "token_id": "relay", "approval_id": 1 }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await?,
        "approvals are not supported",
    );
    Ok(())
}

#[tokio::test]
async fn vault_hooks_are_deed_only_and_stale_epochs_are_ignored() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;

    for (method, args) in [
        ("set_owner", json!({ "new_owner": env.alice.id(), "epoch": 99 })),
        ("lock", json!({ "epoch": 1 })),
        ("unlock", json!({ "epoch": 1 })),
    ] {
        fails(env.alice.call(&vault, method).args_json(args).transact().await?, "only the deed contract");
    }

    // Re-pushing the same epoch is accepted by the deed and ignored by the vault.
    let res = ok(env
        .bob
        .call(env.deed.id(), "sync_vault")
        .args_json(json!({ "token_id": "relay" }))
        .gas(MAX_GAS)
        .transact()
        .await?);
    assert!(has_event(&res, "vault_owner_ignored"));
    assert_eq!(env.vault_info(&vault).await?["owner_id"], env.seller.id().as_str());

    // A vault whose parent is a test account lets us send epochs in any order.
    let fake_deed = env
        .root
        .create_subaccount("fakedeed")
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let v = fake_deed
        .create_subaccount("v")
        .initial_balance(NearToken::from_near(4))
        .transact()
        .await?
        .into_result()?
        .deploy(&Env::vault_wasm()?)
        .await?
        .into_result()?;
    let init = json!({
        "token_id": "t1",
        "owner_id": env.seller.id(),
        "payment_token": env.tusdc.id(),
        "price_per_call": PRICE.to_string(),
        "endpoint": "",
        "image_hash": "",
        "default_daily_cap": "1000000",
    });
    // Only the parent account may initialize.
    fails(env.alice.call(v.id(), "new").args_json(&init).transact().await?, "only the parent deed account");
    done(fake_deed.call(v.id(), "new").args_json(&init).transact().await?);

    let set_owner = |owner: &near_workspaces::AccountId, epoch: u64| {
        fake_deed.call(v.id(), "set_owner").args_json(json!({ "new_owner": owner, "epoch": epoch })).transact()
    };
    assert!(ok(set_owner(env.alice.id(), 3).await?).json::<bool>()?);
    assert!(!ok(set_owner(env.bob.id(), 2).await?).json::<bool>()?, "older epoch ignored");
    assert!(!ok(set_owner(env.bob.id(), 3).await?).json::<bool>()?, "equal epoch ignored");
    let info: Value = v.view("get_info").await?.json()?;
    assert_eq!(info["owner_id"], env.alice.id().as_str());
    assert_eq!(info["owner_epoch"], 3);

    fails(fake_deed.call(v.id(), "lock").args_json(json!({ "epoch": 2 })).transact().await?, "does not match");
    done(fake_deed.call(v.id(), "lock").args_json(json!({ "epoch": 3 })).transact().await?);
    assert!(!ok(fake_deed.call(v.id(), "unlock").args_json(json!({ "epoch": 2 })).transact().await?).json::<bool>()?);
    assert_eq!(v.view("get_info").await?.json::<Value>()?["locked"], true);

    // A newer owner clears the lock.
    assert!(ok(set_owner(env.bob.id(), 4).await?).json::<bool>()?);
    let info: Value = v.view("get_info").await?.json()?;
    assert_eq!(info["locked"], false);
    assert_eq!(info["owner_id"], env.bob.id().as_str());
    Ok(())
}
