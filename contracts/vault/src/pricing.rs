//! Price list with a notice period for increases. Pure logic.

use near_sdk::near;

use crate::ledger::NS_PER_SEC;

/// Customers get this much warning before a price increase applies.
pub const PRICE_INCREASE_NOTICE_NS: u64 = 24 * 3_600 * NS_PER_SEC;

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PriceSchedule {
    pub current: u128,
    /// A scheduled increase: (new price, block timestamp in ns when it applies).
    pub pending: Option<(u128, u64)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PriceChange {
    Immediate,
    Scheduled { effective_at: u64 },
    Unchanged,
}

impl PriceSchedule {
    pub fn new(price: u128) -> Self {
        Self { current: price, pending: None }
    }

    pub fn effective(&self, now: u64) -> u128 {
        match self.pending {
            Some((price, at)) if now >= at => price,
            _ => self.current,
        }
    }

    /// Applies a due pending increase. Returns true if the price changed.
    pub fn settle(&mut self, now: u64) -> bool {
        match self.pending {
            Some((price, at)) if now >= at => {
                self.current = price;
                self.pending = None;
                true
            }
            _ => false,
        }
    }

    /// A decrease (or keeping the current price) applies at once and drops any scheduled
    /// increase. An increase applies only after the notice period.
    pub fn set(&mut self, price: u128, now: u64) -> PriceChange {
        self.settle(now);
        if price == self.current {
            let had_pending = self.pending.take().is_some();
            return if had_pending { PriceChange::Immediate } else { PriceChange::Unchanged };
        }
        if price < self.current {
            self.current = price;
            self.pending = None;
            PriceChange::Immediate
        } else {
            let effective_at = now.saturating_add(PRICE_INCREASE_NOTICE_NS);
            self.pending = Some((price, effective_at));
            PriceChange::Scheduled { effective_at }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_000 * NS_PER_SEC;

    #[test]
    fn decrease_applies_at_once() {
        let mut p = PriceSchedule::new(100);
        assert_eq!(p.set(80, T0), PriceChange::Immediate);
        assert_eq!(p.effective(T0), 80);
    }

    #[test]
    fn increase_waits_for_notice() {
        let mut p = PriceSchedule::new(100);
        let at = T0 + PRICE_INCREASE_NOTICE_NS;
        assert_eq!(p.set(150, T0), PriceChange::Scheduled { effective_at: at });
        assert_eq!(p.effective(T0), 100);
        assert_eq!(p.effective(at - 1), 100);
        assert_eq!(p.effective(at), 150);
        assert!(p.settle(at));
        assert_eq!(p.current, 150);
        assert_eq!(p.pending, None);
    }

    #[test]
    fn decrease_cancels_pending_increase() {
        let mut p = PriceSchedule::new(100);
        p.set(150, T0);
        assert_eq!(p.set(90, T0 + 1), PriceChange::Immediate);
        assert_eq!(p.pending, None);
        assert_eq!(p.effective(T0 + 2 * PRICE_INCREASE_NOTICE_NS), 90);
    }

    #[test]
    fn same_price_cancels_pending_increase() {
        let mut p = PriceSchedule::new(100);
        assert_eq!(p.set(100, T0), PriceChange::Unchanged);
        p.set(150, T0);
        assert_eq!(p.set(100, T0 + 1), PriceChange::Immediate);
        assert_eq!(p.pending, None);
    }

    #[test]
    fn new_increase_restarts_notice() {
        let mut p = PriceSchedule::new(100);
        p.set(150, T0);
        let later = T0 + 3_600 * NS_PER_SEC;
        assert_eq!(
            p.set(200, later),
            PriceChange::Scheduled { effective_at: later + PRICE_INCREASE_NOTICE_NS }
        );
        assert_eq!(p.effective(T0 + PRICE_INCREASE_NOTICE_NS), 100);
    }
}
