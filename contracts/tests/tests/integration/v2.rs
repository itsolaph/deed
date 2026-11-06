use crate::common::{done, fails, has_event, item, ok, u128_of, Env, ONE_TUSDC, PRICE};
use anyhow::Result;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
use serde_json::{json, Value};

#[tokio::test]
async fn exact_quotes_and_missing_quote_on_v2() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "quotes").await?;
    let sk = env.set_worker(&env.seller, &vault).await?;
    done(env.deposit(&env.alice, &vault, 5 * ONE_TUSDC, "").await?);
    let info = env.vault_info(&vault).await?;
    assert_eq!(info["protocol_version"], 2);
    assert!(info["worker_rotation_pending"].is_null());
    let quoted = item(env.alice.id(), 1, 2);
    done(
        env.call_owner(
            &env.seller,
            &vault,
            "set_price",
            json!({"price":(PRICE/2).to_string()}),
        )
        .await?,
    );
    env.worker.fast_forward(50).await?;
    let res = ok(env.charge(&vault, &sk, vec![quoted]).await?);
    let result: Vec<Value> = res.clone().json()?;
    assert_eq!(u128_of(&result[0]["cost"]), 2 * PRICE);
    assert!(res.logs().iter().any(|l| l.contains("\"quoted_price\"")));
    // A low quote also remains exact when the schedule is higher.
    let mut low = item(env.alice.id(), 2, 1);
    low["quoted_price"] = json!((PRICE / 4).to_string());
    let res = ok(env.charge(&vault, &sk, vec![low]).await?);
    assert_eq!(u128_of(&res.json::<Vec<Value>>()?[0]["cost"]), PRICE / 4);
    let mut missing = item(env.alice.id(), 3, 1);
    missing.as_object_mut().unwrap().remove("quoted_price");
    fails(
        env.charge(&vault, &sk, vec![missing]).await?,
        "quoted_price",
    );
    let mut zero = item(env.alice.id(), 3, 1);
    zero["quoted_price"] = json!("0");
    fails(
        env.charge(&vault, &sk, vec![zero]).await?,
        "quoted price must be positive",
    );
    assert_eq!(env.vault_info(&vault).await?["charged_items"], "2");
    env.assert_invariant(&vault).await?;
    Ok(())
}

#[tokio::test]
async fn real_failed_key_batch_rolls_back_then_retry_and_same_key_renewal_succeed() -> Result<()> {
    let env = Env::new(true).await?;
    // Test fixture ONLY: standalone initialized vault retains its creation full-access key.
    // Factory-created production vaults have no such key.
    let acc = env
        .root
        .create_subaccount("rotation-fixture")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?;
    let existing = acc.secret_key().public_key();
    let vault = acc.deploy(&Env::vault_wasm()?).await?.into_result()?;
    done(env.root.call(vault.id(),"new").args_json(json!({
        "token_id":"fixture","owner_id":env.seller.id(),"payment_token":env.tusdc.id(),
        "price_per_call":PRICE.to_string(),"endpoint":"","image_hash":"","default_daily_cap":"1000000"
    })).transact().await?);
    let first = env.set_worker(&env.seller, vault.id()).await?;
    let before: Vec<Value> = vault.view("get_worker_history").await?.json()?;
    let res = ok(env
        .call_owner(
            &env.seller,
            vault.id(),
            "set_worker",
            json!({"public_key":existing.to_string()}),
        )
        .await?);
    assert!(!res.clone().json::<bool>()?);
    assert!(has_event(&res, "vault_worker_set_failed"));
    let info = env.vault_info(vault.id()).await?;
    assert_eq!(info["worker_key"], first.public_key().to_string());
    assert!(info["worker_rotation_pending"].is_null());
    assert_eq!(
        vault
            .view("get_worker_history")
            .await?
            .json::<Vec<Value>>()?,
        before
    );
    let keys = env.worker.view_access_keys(vault.id()).await?;
    assert!(keys.iter().any(|k| k.public_key == first.public_key()));
    assert!(keys.iter().any(|k| k.public_key == existing));
    let next = SecretKey::from_random(KeyType::ED25519);
    assert!(ok(env
        .call_owner(
            &env.seller,
            vault.id(),
            "set_worker",
            json!({"public_key":next.public_key().to_string()})
        )
        .await?)
    .json::<bool>()?);
    let keys = env.worker.view_access_keys(vault.id()).await?;
    assert!(!keys.iter().any(|k| k.public_key == first.public_key()));
    assert!(keys.iter().any(|k| k.public_key == next.public_key()));
    assert!(ok(env.call_owner(&env.seller,vault.id(),"set_worker",json!({"public_key":next.public_key().to_string(),"allowance":NearToken::from_millinear(200).as_yoctonear().to_string()})).await?).json::<bool>()?);
    assert_eq!(
        env.vault_info(vault.id()).await?["worker_key"],
        next.public_key().to_string()
    );
    let keys = env.worker.view_access_keys(vault.id()).await?;
    assert_eq!(
        keys.iter()
            .filter(|k| k.public_key == next.public_key())
            .count(),
        1
    );
    let history: Vec<Value> = vault.view("get_worker_history").await?.json()?;
    // A same-key renewal replaces its history entry instead of pushing a duplicate.
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["public_key"], first.public_key().to_string());
    assert_eq!(history[1]["public_key"], next.public_key().to_string());
    Ok(())
}
