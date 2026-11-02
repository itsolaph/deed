use anyhow::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

use crate::common::{done, fails, has_event, item, ok, Env, MAX_GAS, ONE_TUSDC};
use crate::integration::customers::advance_time;

fn decode_svg(token: &Value) -> String {
    let media = token["metadata"]["media"].as_str().unwrap();
    let b64 = media.strip_prefix("data:image/svg+xml;base64,").unwrap();
    String::from_utf8(STANDARD.decode(b64).unwrap()).unwrap()
}

#[tokio::test]
async fn stats_push_drives_dynamic_metadata() -> Result<()> {
    let env = Env::new(true).await?;
    let vault = env.mint(&env.seller, "relay").await?;
    let sk = env.set_worker(&env.seller, &vault).await?;
    let alice = env.alice.id();
    done(env.deposit(&env.alice, &vault, 10 * ONE_TUSDC, "").await?);

    let nft_token = || env.deed.view("nft_token").args_json(json!({ "token_id": "relay" }));
    let token: Value = nft_token().await?.json()?;
    let svg = decode_svg(&token);
    assert!(svg.contains("No figures reported yet"));
    assert!(token["metadata"]["extra"].is_null());

    // Only the token's own vault may report stats.
    let fake = json!({
        "token_id": "relay",
        "stats": {
            "calls_30d": 999999, "revenue_30d": "1", "gas_spent_30d": "0", "cash": "1",
            "liabilities": "0", "price_per_call": "1", "customers": 0, "owner_epoch": 1, "updated_at_ms": 1
        }
    });
    fails(env.alice.call(env.deed.id(), "on_stats").args_json(fake).transact().await?, "only the token's vault");

    // 123 calls at 0.01 tUSDC = 1.23 tUSDC revenue, then anyone pushes stats.
    env.charge_ok(&vault, &sk, vec![item(alice, 1, 123)]).await?;
    let res = ok(env.bob.call(&vault, "push_stats").gas(MAX_GAS).transact().await?);
    assert!(has_event(&res, "deed_stats"));

    let token: Value = nft_token().await?.json()?;
    let extra: Value = serde_json::from_str(token["metadata"]["extra"].as_str().unwrap())?;
    assert_eq!(extra["calls_30d"], 123);
    assert_eq!(extra["revenue_30d"], "1230000");
    assert_eq!(extra["cash"], "1230000");
    assert_eq!(extra["liabilities"], "8770000");
    let svg = decode_svg(&token);
    assert!(svg.contains(">123<"), "calls shown: {svg}");
    assert!(svg.contains("1.23 tUSDC"));
    assert!(svg.contains("8.77 tUSDC"));
    assert!(svg.contains("Figures as of"));
    assert!(svg.contains(env.seller.id().as_str()));
    assert!(svg.contains("owner epoch 1"));
    assert!(svg.contains("'Archivo','Helvetica Neue',Arial,sans-serif"));
    assert_eq!(svg.matches("#ff4b00").count(), 1, "one orange stamp");
    let description = token["metadata"]["description"].as_str().unwrap();
    assert!(description.contains("123 calls"));
    assert!(!token["metadata"]["updated_at"].is_null());

    // After the push interval a charge pushes stats by itself.
    advance_time(&env, 601).await?;
    let res = ok(env.charge(&vault, &sk, vec![item(alice, 2, 7)]).await?);
    assert!(has_event(&res, "deed_stats"), "charge pushes stats after the interval");
    let token: Value = nft_token().await?.json()?;
    let extra: Value = serde_json::from_str(token["metadata"]["extra"].as_str().unwrap())?;
    assert_eq!(extra["calls_30d"], 130);

    // Enumeration views carry the same live metadata.
    let mine: Vec<Value> = env
        .deed
        .view("nft_tokens_for_owner")
        .args_json(json!({ "account_id": env.seller.id() }))
        .await?
        .json()?;
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0]["metadata"]["extra"], token["metadata"]["extra"]);
    let all: Vec<Value> = env.deed.view("nft_tokens").args_json(json!({})).await?.json()?;
    assert_eq!(all.len(), 1);
    let meta: Value = env.deed.view("nft_metadata").await?.json()?;
    assert_eq!(meta["spec"], "nft-1.0.0");
    assert_eq!(meta["symbol"], "DEED");
    Ok(())
}
