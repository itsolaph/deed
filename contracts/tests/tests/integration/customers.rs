use anyhow::{ensure, Result};
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

use crate::common::{done, fails, has_event, item, ok, u128_of, Env, ONE_TUSDC, MAX_GAS};

/// Moves the sandbox clock forward by at least `secs` seconds.
pub async fn advance_time(env: &Env, secs: u64) -> Result<()> {
    let start = env.worker.view_block().await?.timestamp();
    for _ in 0..40 {
        env.worker.fast_forward(500).await?;
        let now = env.worker.view_block().await?.timestamp();
        if now >= start + secs * 1_000_000_000 {
            return Ok(());
        }
    }
    anyhow::bail!("sandbox clock did not advance {secs} s")
}

#[tokio::test]
async fn deposits_minimum_and_routing() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let alice = env.alice.id();
    let start = env.ft_balance(alice).await?;

    // First deposit below the minimum is refunded in full and creates no entry.
    done(env.deposit(&env.alice, &vault, ONE_TUSDC / 2, "").await?);
    assert_eq!(env.ft_balance(alice).await?, start);
    assert!(env.customer(&vault, alice).await?.is_null());

    let res = ok(env.deposit(&env.alice, &vault, 2 * ONE_TUSDC, "").await?);
    assert!(has_event(&res, "vault_deposit"));
    assert_eq!(u128_of(&env.customer(&vault, alice).await?["balance"]), 2 * ONE_TUSDC);

    // Existing customers may top up any amount.
    done(env.deposit(&env.alice, &vault, ONE_TUSDC / 10, "").await?);
    assert_eq!(u128_of(&env.customer(&vault, alice).await?["balance"]), 21 * ONE_TUSDC / 10);

    // Credit for someone else.
    let msg = json!({ "deposit_for": env.bob.id() }).to_string();
    done(env.deposit(&env.alice, &vault, ONE_TUSDC, &msg).await?);
    assert_eq!(u128_of(&env.customer(&vault, env.bob.id()).await?["balance"]), ONE_TUSDC);

    // Unknown msg is refunded.
    let before = env.ft_balance(alice).await?;
    done(env.deposit(&env.alice, &vault, ONE_TUSDC, "hello").await?);
    assert_eq!(env.ft_balance(alice).await?, before);

    let info = env.vault_info(&vault).await?;
    assert_eq!(u128_of(&info["liabilities"]), 31 * ONE_TUSDC / 10);
    assert_eq!(info["customers"], 2);
    env.assert_invariant(&vault).await?;

    // A different token contract is refused: its ft_on_transfer call panics and the token refunds.
    let fake = env
        .root
        .create_subaccount("fake")
        .initial_balance(NearToken::from_near(5))
        .transact()
        .await?
        .into_result()?
        .deploy(&Env::tusdc_wasm()?)
        .await?
        .into_result()?;
    done(fake.call("new").transact().await?);
    for id in [env.alice.id(), &vault] {
        done(env
            .root
            .call(fake.id(), "storage_deposit")
            .args_json(json!({ "account_id": id, "registration_only": true }))
            .deposit(NearToken::from_micronear(1_250))
            .transact()
            .await?);
    }
    done(env.alice.call(fake.id(), "mint").args_json(json!({ "amount": "5000000" })).transact().await?);
    let res = env
        .alice
        .call(fake.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": vault, "amount": "5000000", "msg": "" }))
        .deposit(NearToken::from_yoctonear(1))
        .gas(MAX_GAS)
        .transact()
        .await?;
    assert_eq!(res.json::<String>()?, "0", "nothing used");
    let fake_balance: Value = fake.view("ft_balance_of").args_json(json!({ "account_id": alice })).await?.json()?;
    assert_eq!(fake_balance, "5000000");
    assert_eq!(u128_of(&env.customer(&vault, alice).await?["balance"]), 21 * ONE_TUSDC / 10);
    env.assert_invariant(&vault).await?;
    Ok(())
}

#[tokio::test]
async fn refund_delay_claim_and_cancel_by_deposit() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let sk = env.set_worker(&env.seller, &vault).await?;
    let alice = env.alice.id();
    done(env.deposit(&env.alice, &vault, 2 * ONE_TUSDC, "").await?);

    let request = || env.alice.call(&vault, "request_refund").gas(MAX_GAS).transact();
    let claim = || env.alice.call(&vault, "claim_refund").gas(MAX_GAS).transact();

    fails(claim().await?, "no refund requested");
    let res = ok(request().await?);
    assert!(has_event(&res, "vault_refund_requested"));
    fails(request().await?, "already requested");
    fails(claim().await?, "refund delay has not passed");

    // Calls already served may still be charged during the delay.
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 1, 3)]).await?, ["charged"]);

    // A new deposit cancels the pending request.
    done(env.deposit(&env.alice, &vault, ONE_TUSDC, "").await?);
    assert!(env.customer(&vault, alice).await?["refund_requested_at_ms"].is_null());
    fails(claim().await?, "no refund requested");

    done(request().await?);
    advance_time(&env, 601).await?;
    let before = env.ft_balance(alice).await?;
    let owed = u128_of(&env.customer(&vault, alice).await?["balance"]);
    ensure!(owed == 3 * ONE_TUSDC - 3 * crate::common::PRICE);
    let res = ok(claim().await?);
    assert!(has_event(&res, "vault_refund"));
    assert!(res.json::<bool>()?);
    assert_eq!(env.ft_balance(alice).await? - before, owed);

    // The entry is freed and the vault keeps only revenue.
    assert!(env.customer(&vault, alice).await?.is_null());
    let info = env.vault_info(&vault).await?;
    assert_eq!(info["customers"], 0);
    assert_eq!(u128_of(&info["liabilities"]), 0);
    env.assert_invariant(&vault).await?;

    // Coming back starts above every seq used before, so old charges cannot replay.
    done(env.deposit(&env.alice, &vault, ONE_TUSDC, "").await?);
    let last_seq: u64 = env.customer(&vault, alice).await?["last_seq"].as_str().unwrap().parse()?;
    assert!(last_seq >= 1);
    assert_eq!(env.charge_ok(&vault, &sk, vec![item(alice, 1, 1)]).await?, ["duplicate"]);
    env.assert_invariant(&vault).await?;
    Ok(())
}
