use anyhow::Result;
use near_workspaces::types::AccessKeyPermission;
use near_workspaces::ContractState;
use serde_json::Value;

use crate::common::{fails, has_event, ok, Env};

#[tokio::test]
async fn mint_creates_vault_without_full_access_key() -> Result<()> {
    let env = Env::new(true).await?;
    let before = env.seller.view_account().await?.balance;
    let cost = env.mint_cost().await?;
    // Overpay by 1 NEAR: the excess must come back.
    let res = ok(env.try_mint(&env.seller, "relay", cost + 10u128.pow(24)).await?);
    assert!(has_event(&res, "nft_mint"));
    assert!(has_event(&res, "outlive_vault_created"));
    assert!(res.json::<bool>()?);
    // Spent = cost + prepaid gas (300 Tgas, refunded later). Well under cost + the 1 NEAR excess.
    let spent = before.as_yoctonear() - env.seller.view_account().await?.balance.as_yoctonear();
    assert!(spent >= cost && spent < cost + 4 * 10u128.pow(23), "spent {spent}, cost {cost}");

    let vault: near_workspaces::AccountId = format!("relay.{}", env.outlive.id()).parse()?;
    let keys = env.worker.view_access_keys(&vault).await?;
    assert!(keys.is_empty(), "vault must start with no keys, has {}", keys.len());

    // Code on the vault account is the code the outlive advertises.
    let advertised: Value = env.outlive.view("vault_code_hash").await?.json()?;
    match env.worker.view_account(&vault).await?.contract_state {
        ContractState::LocalHash(hash) => {
            assert_eq!(hash.to_string(), advertised["sha256_base58"].as_str().unwrap())
        }
        other => panic!("unexpected contract state {other:?}"),
    }

    let info = env.vault_info(&vault).await?;
    assert_eq!(info["owner_id"], env.seller.id().as_str());
    assert_eq!(info["owner_epoch"], 1);
    assert_eq!(info["locked"], false);
    assert_eq!(info["outlive_id"], env.outlive.id().as_str());
    assert_eq!(info["token_id"], "relay");

    let token: Value = env.outlive.view("nft_token").args_json(serde_json::json!({ "token_id": "relay" })).await?.json()?;
    assert_eq!(token["owner_id"], env.seller.id().as_str());
    assert!(token["metadata"]["media"].as_str().unwrap().starts_with("data:image/svg+xml;base64,"));

    // The vault is registered on the payment token, so customers can deposit right away.
    let reg: Value = env
        .tusdc
        .view("storage_balance_of")
        .args_json(serde_json::json!({ "account_id": vault }))
        .await?
        .json()?;
    assert!(!reg.is_null());

    // After set_worker the only key is a function-call key limited to `charge` on the vault.
    env.set_worker(&env.seller, &vault).await?;
    let keys = env.worker.view_access_keys(&vault).await?;
    assert_eq!(keys.len(), 1);
    match &keys[0].access_key.permission {
        AccessKeyPermission::FunctionCall(p) => {
            assert_eq!(p.receiver_id, vault.as_str());
            assert_eq!(p.method_names, vec!["charge".to_string()]);
            assert!(p.allowance.is_some(), "allowance must be capped");
        }
        AccessKeyPermission::FullAccess => panic!("vault got a full-access key"),
    }
    Ok(())
}

#[tokio::test]
async fn mint_rejections_create_nothing() -> Result<()> {
    let env = Env::new(true).await?;
    let cost = env.mint_cost().await?;

    let before = env.seller.view_account().await?.balance.as_yoctonear();
    fails(env.try_mint(&env.seller, "relay", cost - 1).await?, "mint_cost");
    let after = env.seller.view_account().await?.balance.as_yoctonear();
    assert!(before - after < 10u128.pow(22), "only gas may be spent on a refused mint");
    let vault: near_workspaces::AccountId = format!("relay.{}", env.outlive.id()).parse()?;
    assert!(env.worker.view_account(&vault).await.is_err(), "no vault account");
    let supply: Value = env.outlive.view("nft_total_supply").await?.json()?;
    assert_eq!(supply, "0");

    for bad in ["R", "a", "-relay", "re--lay", "re_lay"] {
        fails(env.try_mint(&env.seller, bad, cost).await?, "slug");
    }

    env.mint(&env.seller, "relay").await?;
    fails(env.try_mint(&env.alice, "relay", cost).await?, "slug is taken");
    let supply: Value = env.outlive.view("nft_total_supply").await?.json()?;
    assert_eq!(supply, "1");
    Ok(())
}
