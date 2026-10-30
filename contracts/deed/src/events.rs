//! NEP-297 events with standard "deed" and names starting with `deed_`. Token moves also emit
//! the standard NEP-171 `nft_mint` and `nft_transfer` events.

use near_sdk::env;
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json};

pub const EVENT_STANDARD: &str = "deed";
pub const EVENT_VERSION: &str = "1.0.0";

pub fn emit<T: Serialize>(event: &str, data: T) {
    let payload = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", serde_json::to_string(&payload).unwrap()));
}
