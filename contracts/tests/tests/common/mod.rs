//! Shared sandbox setup for the integration tests.
//!
//! Each test starts its own sandbox node. RPC and network ports come from 127.0.0.1:7640-7699
//! so tests never bind outside the project's port range. Wasm files come from
//! `contracts/target/near`, so run `scripts/build.sh` first.
#![allow(dead_code)]

use std::sync::atomic::{AtomicU16, Ordering};

use anyhow::{bail, ensure, Context, Result};
use near_sandbox::SandboxConfig;
use near_workspaces::network::{Sandbox, ValidatorKey};
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

pub const ONE_TUSDC: u128 = 1_000_000;
pub const PRICE: u128 = 10_000; // 0.01 tUSDC per call
pub const DAILY_CAP: u128 = 5 * ONE_TUSDC;
pub const ROOT_HEX: &str = "abababababababababababababababababababababababababababababababab";
pub const FT_STORAGE: NearToken = NearToken::from_micronear(1_250);
pub const MAX_GAS: Gas = Gas::from_tgas(300);

const FIRST_PORT: u16 = 7640;
const LAST_PORT: u16 = 7699;
static NEXT_PORT: AtomicU16 = AtomicU16::new(FIRST_PORT);

fn wasm(name: &str) -> Result<Vec<u8>> {
    let path = format!("{}/../target/near/{name}/{name}.wasm", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).with_context(|| format!("missing {path}; run scripts/build.sh first"))
}

pub async fn start_sandbox() -> Result<(near_sandbox::Sandbox, Worker<Sandbox>)> {
    loop {
        let port = NEXT_PORT.fetch_add(2, Ordering::SeqCst);
        ensure!(port < LAST_PORT, "no free test ports left in {FIRST_PORT}-{LAST_PORT}");
        let config = SandboxConfig {
            rpc_port: Some(port),
            net_port: Some(port + 1),
            ..Default::default()
        };
        match near_sandbox::Sandbox::start_sandbox_with_config(config).await {
            Ok(sandbox) => {
                let worker = near_workspaces::sandbox()
                    .rpc_addr(&sandbox.rpc_addr)
                    .validator_key(ValidatorKey::HomeDir(sandbox.home_dir.path().to_path_buf()))
                    .await?;
                return Ok((sandbox, worker));
            }
            Err(e) => eprintln!("sandbox on port {port} failed ({e}), trying the next pair"),
        }
    }
}

pub fn item(customer: &AccountId, seq: u64, units: u32) -> Value {
    json!({ "customer": customer, "seq": seq, "units": units, "receipts_root": ROOT_HEX })
}

/// Asserts the final outcome succeeded and returns it.
pub fn ok(res: ExecutionFinalResult) -> ExecutionFinalResult {
    assert!(res.is_success(), "expected success, got {:#?}", res.failures());
    res
}

/// Like `ok` for calls whose result is not needed.
pub fn done(res: ExecutionFinalResult) {
    let _ = ok(res);
}

/// Asserts the transaction failed with a message containing `needle`.
pub fn fails(res: ExecutionFinalResult, needle: &str) {
    assert!(res.is_failure(), "expected failure containing {needle:?}, got success");
    let text = format!("{:?}", res.failures());
    assert!(text.contains(needle), "failure did not contain {needle:?}: {text}");
}

pub fn has_event(res: &ExecutionFinalResult, event: &str) -> bool {
    let needle = format!("\"event\":\"{event}\"");
    res.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains(&needle))
}

pub fn u128_of(v: &Value) -> u128 {
    v.as_str().expect("u128 as string").parse().expect("u128")
}

pub struct Env {
    _sandbox: near_sandbox::Sandbox,
    pub worker: Worker<Sandbox>,
    pub root: Account,
    pub outlive: Contract,
    pub tusdc: Contract,
    pub seller: Account,
    pub buyer: Account,
    pub alice: Account,
    pub bob: Account,
}

impl Env {
    /// Outlive + tUSDC deployed; buyer, alice and bob registered on tUSDC with 1,000 tUSDC each.
    /// The seller is registered too unless `register_seller` is false.
    pub async fn new(register_seller: bool) -> Result<Self> {
        let (sandbox, worker) = start_sandbox().await?;
        let root = worker.root_account()?;

        let tusdc = Self::deploy(&root, "tusdc", "tusdc", NearToken::from_near(10)).await?;
        done(tusdc.call("new").transact().await?);
        let outlive = Self::deploy(&root, "outlive", "outlive", NearToken::from_near(30)).await?;
        done(outlive
            .call("new")
            .args_json(json!({ "admin_id": root.id(), "payment_token": tusdc.id(), "payment_symbol": "tUSDC" }))
            .transact()
            .await?);

        let mut users = Vec::new();
        for name in ["seller", "buyer", "alice", "bob"] {
            let acc = root
                .create_subaccount(name)
                .initial_balance(NearToken::from_near(30))
                .transact()
                .await?
                .into_result()?;
            users.push(acc);
        }
        let [seller, buyer, alice, bob]: [Account; 4] = users.try_into().unwrap();
        let env = Self { _sandbox: sandbox, worker, root, outlive, tusdc, seller, buyer, alice, bob };

        env.register(env.outlive.id()).await?;
        for acc in [&env.buyer, &env.alice, &env.bob] {
            env.register(acc.id()).await?;
            env.faucet(acc, 1_000 * ONE_TUSDC).await?;
        }
        if register_seller {
            env.register(env.seller.id()).await?;
        }
        Ok(env)
    }

    async fn deploy(root: &Account, sub: &str, wasm_name: &str, balance: NearToken) -> Result<Contract> {
        let acc = root.create_subaccount(sub).initial_balance(balance).transact().await?.into_result()?;
        Ok(acc.deploy(&wasm(wasm_name)?).await?.into_result()?)
    }

    pub fn vault_wasm() -> Result<Vec<u8>> {
        wasm("vault")
    }

    pub fn tusdc_wasm() -> Result<Vec<u8>> {
        wasm("tusdc")
    }

    pub async fn register(&self, id: &AccountId) -> Result<()> {
        done(self
            .root
            .call(self.tusdc.id(), "storage_deposit")
            .args_json(json!({ "account_id": id, "registration_only": true }))
            .deposit(FT_STORAGE)
            .transact()
            .await?);
        Ok(())
    }

    pub async fn faucet(&self, acc: &Account, amount: u128) -> Result<()> {
        let mut left = amount;
        while left > 0 {
            let step = left.min(1_000 * ONE_TUSDC);
            done(acc
                .call(self.tusdc.id(), "mint")
                .args_json(json!({ "amount": step.to_string() }))
                .transact()
                .await?);
            left -= step;
        }
        Ok(())
    }

    pub async fn ft_balance(&self, id: &AccountId) -> Result<u128> {
        let v: Value = self
            .tusdc
            .view("ft_balance_of")
            .args_json(json!({ "account_id": id }))
            .await?
            .json()?;
        Ok(u128_of(&v))
    }

    pub async fn mint_cost(&self) -> Result<u128> {
        let v: Value = self.outlive.view("mint_cost").await?.json()?;
        Ok(u128_of(&v))
    }

    pub async fn try_mint(&self, owner: &Account, slug: &str, deposit: u128) -> Result<ExecutionFinalResult> {
        Ok(owner
            .call(self.outlive.id(), "mint")
            .args_json(json!({
                "slug": slug,
                "title": "Webhook Relay",
                "price_per_call": PRICE.to_string(),
                "endpoint": "https://relay.example/v1",
                "image_hash": "sha256:0000",
                "default_daily_cap": DAILY_CAP.to_string(),
            }))
            .deposit(NearToken::from_yoctonear(deposit))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    /// Mints a outlive and returns the vault account id.
    pub async fn mint(&self, owner: &Account, slug: &str) -> Result<AccountId> {
        let cost = self.mint_cost().await?;
        let res = ok(self.try_mint(owner, slug, cost).await?);
        let logs = format!("{:?}", res.logs());
        ensure!(res.json::<bool>()?, "mint callback reported failure: {logs}");
        Ok(format!("{slug}.{}", self.outlive.id()).parse()?)
    }

    pub async fn deposit(&self, from: &Account, vault: &AccountId, amount: u128, msg: &str) -> Result<ExecutionFinalResult> {
        Ok(from
            .call(self.tusdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": vault, "amount": amount.to_string(), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    pub async fn vault_info(&self, vault: &AccountId) -> Result<Value> {
        Ok(self.worker.view(vault, "get_info").await?.json()?)
    }

    pub async fn customer(&self, vault: &AccountId, id: &AccountId) -> Result<Value> {
        Ok(self
            .worker
            .view(vault, "get_customer")
            .args_json(json!({ "account_id": id }))
            .await?
            .json()?)
    }

    pub async fn outlive_view(&self, token_id: &str) -> Result<Value> {
        Ok(self.outlive.view("get_token").args_json(json!({ "token_id": token_id })).await?.json()?)
    }

    pub async fn call_owner(&self, owner: &Account, vault: &AccountId, method: &str, args: Value) -> Result<ExecutionFinalResult> {
        Ok(owner
            .call(vault, method)
            .args_json(args)
            .deposit(NearToken::from_yoctonear(1))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    /// Registers a fresh worker key on the vault and returns its secret key.
    pub async fn set_worker(&self, owner: &Account, vault: &AccountId) -> Result<SecretKey> {
        let sk = SecretKey::from_random(KeyType::ED25519);
        let res = ok(self
            .call_owner(owner, vault, "set_worker", json!({ "public_key": sk.public_key().to_string() }))
            .await?);
        let logs = format!("{:?}", res.logs());
        ensure!(res.json::<bool>()?, "set_worker callback failed: {logs}");
        Ok(sk)
    }

    /// Sends `charge` signed as the vault account with `sk`.
    pub async fn charge(&self, vault: &AccountId, sk: &SecretKey, items: Vec<Value>) -> Result<ExecutionFinalResult> {
        let signer = Account::from_secret_key(vault.clone(), sk.clone(), &self.worker);
        Ok(signer
            .call(vault, "charge")
            .args_json(json!({ "items": items }))
            .gas(Gas::from_tgas(100))
            .transact()
            .await?)
    }

    pub async fn charge_ok(&self, vault: &AccountId, sk: &SecretKey, items: Vec<Value>) -> Result<Vec<String>> {
        let res = ok(self.charge(vault, sk, items).await?);
        let results: Vec<Value> = res.json()?;
        Ok(results.iter().map(|r| r["status"].as_str().unwrap().to_string()).collect())
    }

    /// The vault's payment-token balance equals liabilities + revenue + amounts in flight.
    pub async fn assert_invariant(&self, vault: &AccountId) -> Result<()> {
        let info = self.vault_info(vault).await?;
        let held = self.ft_balance(vault).await?;
        let owed = u128_of(&info["liabilities"]) + u128_of(&info["revenue"]) + u128_of(&info["in_flight"]);
        if held != owed {
            bail!("invariant broken for {vault}: token balance {held} != liabilities+revenue+in_flight {owed} ({info})");
        }
        Ok(())
    }

    /// The outlive's payment-token balance equals proceeds held for sellers plus those in flight.
    pub async fn assert_outlive_invariant(&self) -> Result<()> {
        let cfg: Value = self.outlive.view("get_config").await?.json()?;
        let held = self.ft_balance(self.outlive.id()).await?;
        let owed = u128_of(&cfg["proceeds_total"]) + u128_of(&cfg["proceeds_in_flight"]);
        ensure!(held == owed, "outlive invariant broken: balance {held} != proceeds {owed}");
        Ok(())
    }

    pub async fn list(&self, owner: &Account, token_id: &str, price: u128) -> Result<ExecutionFinalResult> {
        Ok(owner
            .call(self.outlive.id(), "list")
            .args_json(json!({ "token_id": token_id, "price": price.to_string() }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    pub async fn buy(&self, buyer: &Account, token_id: &str, amount: u128, max_price: u128) -> Result<ExecutionFinalResult> {
        let msg = json!({ "buy": { "token_id": token_id, "max_price": max_price.to_string() } }).to_string();
        Ok(buyer
            .call(self.tusdc.id(), "ft_transfer_call")
            .args_json(json!({ "receiver_id": self.outlive.id(), "amount": amount.to_string(), "msg": msg }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }

    pub async fn transfer(&self, from: &Account, to: &AccountId, token_id: &str) -> Result<ExecutionFinalResult> {
        Ok(from
            .call(self.outlive.id(), "nft_transfer")
            .args_json(json!({ "receiver_id": to, "token_id": token_id }))
            .deposit(NearToken::from_yoctonear(1))
            .gas(MAX_GAS)
            .transact()
            .await?)
    }
}
