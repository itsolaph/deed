//! Customer ledger rules. Pure logic, no host calls, so it is easy to unit test.

use near_sdk::near;

pub const NS_PER_SEC: u64 = 1_000_000_000;
pub const NS_PER_DAY: u64 = 86_400 * NS_PER_SEC;

/// UTC day number (days since the unix epoch) for a block timestamp in nanoseconds.
pub fn utc_day(timestamp_ns: u64) -> u32 {
    (timestamp_ns / NS_PER_DAY) as u32
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Customer {
    /// Prepaid credit in the payment token's smallest unit. Counted in `liabilities`.
    pub balance: u128,
    /// Maximum amount that may be charged per UTC day.
    pub daily_cap: u128,
    /// Amount charged on `day`.
    pub spent_today: u128,
    /// UTC day that `spent_today` belongs to.
    pub day: u32,
    /// Highest charge sequence number applied for this customer.
    pub last_seq: u64,
    /// Block timestamp (ns) of a pending refund request.
    pub refund_requested_at: Option<u64>,
}

/// Result of applying one charge item to a customer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChargeOutcome {
    Charged(u128),
    /// `seq` was already applied. Never charged twice.
    Duplicate,
    /// `seq` skips ahead of `last_seq + 1`.
    SeqGap,
    InvalidUnits,
    InsufficientBalance,
    OverDailyCap,
    Overflow,
}

impl ChargeOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            ChargeOutcome::Charged(_) => "charged",
            ChargeOutcome::Duplicate => "duplicate",
            ChargeOutcome::SeqGap => "seq_gap",
            ChargeOutcome::InvalidUnits => "invalid_units",
            ChargeOutcome::InsufficientBalance => "insufficient_balance",
            ChargeOutcome::OverDailyCap => "over_daily_cap",
            ChargeOutcome::Overflow => "overflow",
        }
    }
}

impl Customer {
    pub fn new(daily_cap: u128, seq_floor: u64) -> Self {
        Self {
            balance: 0,
            daily_cap,
            spent_today: 0,
            day: 0,
            last_seq: seq_floor,
            refund_requested_at: None,
        }
    }

    /// Amount already charged on `today`. A stale `day` means nothing was charged today.
    pub fn spent_on(&self, today: u32) -> u128 {
        if self.day == today {
            self.spent_today
        } else {
            0
        }
    }

    /// What is still chargeable today: the smaller of balance and remaining cap.
    pub fn chargeable_today(&self, today: u32) -> u128 {
        let cap_left = self.daily_cap.saturating_sub(self.spent_on(today));
        cap_left.min(self.balance)
    }

    /// Applies one charge. On any outcome other than `Charged` the customer is unchanged.
    pub fn try_charge(&mut self, seq: u64, units: u32, price: u128, today: u32) -> ChargeOutcome {
        if seq <= self.last_seq {
            return ChargeOutcome::Duplicate;
        }
        if Some(seq) != self.last_seq.checked_add(1) {
            return ChargeOutcome::SeqGap;
        }
        if units == 0 {
            return ChargeOutcome::InvalidUnits;
        }
        let Some(cost) = price.checked_mul(units as u128) else {
            return ChargeOutcome::Overflow;
        };
        if cost > self.balance {
            return ChargeOutcome::InsufficientBalance;
        }
        let Some(spent) = self.spent_on(today).checked_add(cost) else {
            return ChargeOutcome::Overflow;
        };
        if spent > self.daily_cap {
            return ChargeOutcome::OverDailyCap;
        }
        self.balance -= cost;
        self.spent_today = spent;
        self.day = today;
        self.last_seq = seq;
        ChargeOutcome::Charged(cost)
    }

    /// A new deposit adds credit and cancels a pending refund request.
    pub fn credit(&mut self, amount: u128) -> Option<()> {
        self.balance = self.balance.checked_add(amount)?;
        self.refund_requested_at = None;
        Some(())
    }

    pub fn refund_available_at(&self, delay_ns: u64) -> Option<u64> {
        self.refund_requested_at.map(|t| t.saturating_add(delay_ns))
    }
}

/// `receipts_root` must be a lowercase or uppercase hex sha256 (64 chars).
pub fn is_hex_sha256(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PRICE: u128 = 1_000;
    const DAY: u32 = 20_000;

    fn funded(balance: u128, cap: u128) -> Customer {
        let mut c = Customer::new(cap, 0);
        c.credit(balance).unwrap();
        c
    }

    #[test]
    fn utc_day_rolls_at_midnight() {
        assert_eq!(utc_day(0), 0);
        assert_eq!(utc_day(NS_PER_DAY - 1), 0);
        assert_eq!(utc_day(NS_PER_DAY), 1);
        assert_eq!(utc_day(NS_PER_DAY * 20_000 + 5), 20_000);
    }

    #[test]
    fn seq_must_be_next() {
        let mut c = funded(10_000, 10_000);
        assert_eq!(c.try_charge(1, 1, PRICE, DAY), ChargeOutcome::Charged(PRICE));
        assert_eq!(c.try_charge(3, 1, PRICE, DAY), ChargeOutcome::SeqGap);
        assert_eq!(c.try_charge(2, 1, PRICE, DAY), ChargeOutcome::Charged(PRICE));
        assert_eq!(c.last_seq, 2);
    }

    #[test]
    fn replayed_seq_is_never_charged_twice() {
        let mut c = funded(10_000, 10_000);
        assert_eq!(c.try_charge(1, 2, PRICE, DAY), ChargeOutcome::Charged(2 * PRICE));
        let before = c.clone();
        assert_eq!(c.try_charge(1, 2, PRICE, DAY), ChargeOutcome::Duplicate);
        assert_eq!(c.try_charge(0, 2, PRICE, DAY), ChargeOutcome::Duplicate);
        assert_eq!(c, before);
    }

    #[test]
    fn seq_floor_starts_new_customers_above_old_seqs() {
        let mut c = Customer::new(10_000, 41);
        c.credit(5_000).unwrap();
        assert_eq!(c.try_charge(41, 1, PRICE, DAY), ChargeOutcome::Duplicate);
        assert_eq!(c.try_charge(42, 1, PRICE, DAY), ChargeOutcome::Charged(PRICE));
    }

    #[test]
    fn balance_limits_charges() {
        let mut c = funded(1_500, 10_000);
        assert_eq!(c.try_charge(1, 2, PRICE, DAY), ChargeOutcome::InsufficientBalance);
        assert_eq!(c.last_seq, 0, "failed item does not consume the seq");
        assert_eq!(c.try_charge(1, 1, PRICE, DAY), ChargeOutcome::Charged(PRICE));
        assert_eq!(c.balance, 500);
    }

    #[test]
    fn daily_cap_limits_charges_and_resets_next_day() {
        let mut c = funded(10_000, 2_500);
        assert_eq!(c.try_charge(1, 2, PRICE, DAY), ChargeOutcome::Charged(2 * PRICE));
        assert_eq!(c.try_charge(2, 1, PRICE, DAY), ChargeOutcome::OverDailyCap);
        assert_eq!(c.chargeable_today(DAY), 500);
        assert_eq!(c.spent_on(DAY + 1), 0);
        assert_eq!(c.try_charge(2, 1, PRICE, DAY + 1), ChargeOutcome::Charged(PRICE));
        assert_eq!(c.spent_today, PRICE);
        assert_eq!(c.day, DAY + 1);
    }

    #[test]
    fn zero_units_and_overflow_are_rejected() {
        let mut c = funded(10_000, u128::MAX);
        assert_eq!(c.try_charge(1, 0, PRICE, DAY), ChargeOutcome::InvalidUnits);
        assert_eq!(c.try_charge(1, 2, u128::MAX, DAY), ChargeOutcome::Overflow);
    }

    #[test]
    fn deposit_cancels_refund_request() {
        let mut c = funded(1_000, 1_000);
        c.refund_requested_at = Some(5);
        assert_eq!(c.refund_available_at(10), Some(15));
        c.credit(1).unwrap();
        assert_eq!(c.refund_requested_at, None);
        assert_eq!(c.balance, 1_001);
    }

    #[test]
    fn hex_root_check() {
        assert!(is_hex_sha256(&"ab".repeat(32)));
        assert!(!is_hex_sha256(&"ab".repeat(31)));
        assert!(!is_hex_sha256(&"zz".repeat(32)));
    }
}
