use super::*;
use near_sdk::serde_json::{self, json};
use near_sdk::{test_utils::VMContextBuilder, testing_env};

fn context(predecessor: &str, time: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("relay.factory.test".parse().unwrap())
        .predecessor_account_id(predecessor.parse().unwrap())
        .signer_account_pk(key(1))
        .block_timestamp(time)
        .attached_deposit(NearToken::from_yoctonear(1));
    testing_env!(b.build());
}
fn key(n: u8) -> PublicKey {
    PublicKey::from_parts(near_sdk::CurveType::ED25519, vec![n; 32]).unwrap()
}
fn vault() -> Vault {
    context("factory.test", 0);
    let mut v = Vault::new(
        "relay".into(),
        "owner.test".parse().unwrap(),
        "token.test".parse().unwrap(),
        U128(10),
        "".into(),
        "".into(),
        U128(1000),
        None,
        None,
    );
    v.worker_key = Some(key(1));
    let mut c = Customer::new(1000, 0);
    c.balance = 1000;
    v.customers.insert("alice.test".parse().unwrap(), c);
    v.liabilities = 1000;
    v
}
fn item(quote: Option<&str>, seq: u64) -> Result<ChargeItem, serde_json::Error> {
    let mut x =
        json!({"customer":"alice.test","seq":seq,"units":2,"receipts_root":"ab".repeat(32)});
    if let Some(p) = quote {
        x["quoted_price"] = json!(p);
    }
    serde_json::from_value(x)
}
#[test]
fn missing_quote_fails_closed() {
    assert!(item(None, 1).is_err());
}
#[test]
fn exact_quote_survives_increase_decrease_and_delay() {
    let mut v = vault();
    v.price.set(30, 0);
    context("relay.factory.test", ledger::NS_PER_DAY + 1);
    assert_eq!(v.charge(vec![item(Some("10"), 1).unwrap()])[0].cost.0, 20);
    v.price.set(3, ledger::NS_PER_DAY + 1);
    assert_eq!(v.charge(vec![item(Some("30"), 2).unwrap()])[0].cost.0, 60);
    assert_eq!(v.liabilities, 920);
    assert_eq!(v.revenue, 80);
}
#[test]
#[should_panic(expected = "quoted price must be positive")]
fn zero_quote_rejected() {
    let mut v = vault();
    context("relay.factory.test", 0);
    v.charge(vec![item(Some("0"), 1).unwrap()]);
}
#[test]
fn rotation_does_not_publish_proposed_key_or_evict_history() {
    let mut v = vault();
    for n in 1..=10 {
        v.worker_history.push(WorkerKeyRecord {
            public_key: key(n),
            set_at: 0,
            owner_epoch: 1,
        });
    }
    context("owner.test", 0);
    v.set_worker(key(11), None).detach();
    assert_eq!(v.worker_key, Some(key(1)));
    assert_eq!(v.worker_history.len(), 10);
    assert_eq!(v.worker_history[0].public_key, key(1));
}
#[test]
#[should_panic(expected = "worker rotation pending")]
fn concurrent_rotation_rejected() {
    let mut v = vault();
    context("owner.test", 0);
    v.set_worker(key(2), None).detach();
    v.set_worker(key(3), None).detach();
}

// Fault injection only: mocked promise failures are not a live exploit demonstration.
fn callback_result(success: bool) {
    callback_result_at(success, 0);
}
fn callback_result_at(success: bool, time: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("relay.factory.test".parse().unwrap())
        .predecessor_account_id("relay.factory.test".parse().unwrap())
        .block_timestamp(time);
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![if success {
            near_sdk::PromiseResult::Successful(vec![])
        } else {
            near_sdk::PromiseResult::Failed
        }]
    );
}
#[test]
fn failed_callback_preserves_full_history_and_retry_ignores_stale_callbacks() {
    let mut v = vault();
    for n in 1..=10 {
        v.worker_history.push(WorkerKeyRecord {
            public_key: key(n),
            set_at: 0,
            owner_epoch: 1,
        });
    }
    context("owner.test", 0);
    v.set_worker(key(11), None).detach();
    callback_result(false);
    assert!(!v.on_worker_set(1));
    assert_eq!(v.worker_key, Some(key(1)));
    assert_eq!(v.worker_history.len(), 10);
    assert_eq!(v.worker_history[0].public_key, key(1));
    assert!(v.worker_rotation_pending.is_none());
    context("owner.test", 0);
    v.set_worker(key(12), None).detach();
    callback_result(true);
    assert!(!v.on_worker_set(1));
    assert!(v.worker_rotation_pending.is_some());
    v.owner_epoch = 2; // Ownership can advance while the real key batch is in flight.
    assert!(v.on_worker_set(2));
    assert_eq!(v.worker_key, Some(key(12)));
    assert_eq!(v.worker_history.len(), 10);
    assert_eq!(v.worker_history[0].public_key, key(2));
    assert_eq!(v.worker_history.last().unwrap().owner_epoch, 1);
    assert!(!v.on_worker_set(2));
}
#[test]
fn same_key_renewal_deletes_and_adds_in_one_batch() {
    let mut v = vault();
    context("owner.test", 0);
    v.set_worker(key(1), Some(U128(99))).detach();
    let receipts = near_sdk::test_utils::get_created_receipts();
    let text = format!("{receipts:?}");
    let delete = text.find("DeleteKey").expect("delete even the same key");
    let add = text.find("AddKey").expect("add renewed allowance");
    assert!(delete < add);
    callback_result(true);
    assert!(v.on_worker_set(1));
    assert_eq!(v.worker_key, Some(key(1)));
}

#[test]
fn same_key_renewal_keeps_history_entry_and_oldest_distinct_key() {
    let mut v = vault();
    for n in 1..=10 {
        v.worker_history.push(WorkerKeyRecord {
            public_key: key(n),
            set_at: 0,
            owner_epoch: 1,
        });
    }
    // Renew the active key while the ring is full: no duplicate slot, no eviction of key(1).
    context("owner.test", 42);
    v.set_worker(key(10), None).detach();
    callback_result_at(true, 42);
    assert!(v.on_worker_set(1));
    assert_eq!(v.worker_key, Some(key(10)));
    assert_eq!(v.worker_history.len(), 10);
    assert_eq!(v.worker_history[0].public_key, key(1));
    assert_eq!(v.worker_history[9].public_key, key(10));
    assert_eq!(v.worker_history[9].set_at, 42);
    // A later distinct rotation keeps the ring consistent.
    context("owner.test", 43);
    v.set_worker(key(11), None).detach();
    callback_result(true);
    assert!(v.on_worker_set(2));
    assert_eq!(v.worker_history.len(), 10);
    assert_eq!(v.worker_history[0].public_key, key(2));
    assert_eq!(v.worker_history[9].public_key, key(11));
}

#[test]
fn quote_cannot_bypass_balance_cap_sequence_or_overflow_checks() {
    let mut v = vault();
    context("relay.factory.test", 0);
    assert_eq!(
        v.charge(vec![item(Some("600"), 1).unwrap()])[0].status,
        "insufficient_balance"
    );
    assert_eq!(
        v.charge(vec![item(Some(&u128::MAX.to_string()), 1).unwrap()])[0].status,
        "overflow"
    );
    v.customers
        .get_mut(&"alice.test".parse::<AccountId>().unwrap())
        .unwrap()
        .daily_cap = 15;
    assert_eq!(
        v.charge(vec![item(Some("10"), 1).unwrap()])[0].status,
        "over_daily_cap"
    );
    assert_eq!(
        v.charge(vec![item(Some("1"), 2).unwrap()])[0].status,
        "seq_gap"
    );
    assert_eq!(v.charge(vec![item(Some("1"), 1).unwrap()])[0].cost.0, 2);
    assert_eq!(
        v.charge(vec![item(Some("9"), 1).unwrap()])[0].status,
        "duplicate"
    );
    assert_eq!(v.liabilities, 998);
    assert_eq!(v.revenue, 2);
}
