//! Sandbox integration tests for the deed, vault and tUSDC contracts.
//! One test binary so every sandbox gets its own port pair from the shared counter.

#[path = "common/mod.rs"]
mod common;

mod integration {
    pub mod charge;
    pub mod customers;
    pub mod metadata;
    pub mod mint;
    pub mod ownership;
    pub mod owner_powers;
    pub mod review;
    pub mod sale;
}
