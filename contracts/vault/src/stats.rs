//! 30 daily stat buckets kept as a ring indexed by UTC day. Pure logic.

use near_sdk::json_types::U128;
use near_sdk::near;

pub const STAT_DAYS: u32 = 30;

#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct DayBucket {
    pub day: u32,
    pub calls: u64,
    pub revenue: u128,
    /// NEAR (yocto) the vault spent on gas from its own balance on this day.
    pub gas_spent: u128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DayBucketView {
    pub day: u32,
    pub calls: u64,
    pub revenue: U128,
    pub gas_spent: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StatsView {
    pub today: u32,
    pub calls_30d: u64,
    pub revenue_30d: U128,
    pub gas_spent_30d: U128,
    pub calls_total: u64,
    pub revenue_total: U128,
    /// Days with activity in the last 30, oldest first.
    pub days: Vec<DayBucketView>,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct StatsRing {
    buckets: Vec<DayBucket>,
    pub calls_total: u64,
    pub revenue_total: u128,
}

impl Default for StatsRing {
    fn default() -> Self {
        Self {
            buckets: vec![DayBucket::default(); STAT_DAYS as usize],
            calls_total: 0,
            revenue_total: 0,
        }
    }
}

impl StatsRing {
    fn bucket_mut(&mut self, day: u32) -> &mut DayBucket {
        let slot = &mut self.buckets[(day % STAT_DAYS) as usize];
        if slot.day != day {
            *slot = DayBucket { day, ..DayBucket::default() };
        }
        slot
    }

    fn in_window(day: u32, today: u32) -> bool {
        day <= today && today - day < STAT_DAYS
    }

    pub fn record_charge(&mut self, day: u32, calls: u64, revenue: u128) {
        let b = self.bucket_mut(day);
        b.calls = b.calls.saturating_add(calls);
        b.revenue = b.revenue.saturating_add(revenue);
        self.calls_total = self.calls_total.saturating_add(calls);
        self.revenue_total = self.revenue_total.saturating_add(revenue);
    }

    /// Positive `delta` adds gas spending, negative removes it (gas refunds arrive later).
    pub fn record_gas(&mut self, day: u32, delta: i128) {
        let b = self.bucket_mut(day);
        if delta >= 0 {
            b.gas_spent = b.gas_spent.saturating_add(delta as u128);
        } else {
            b.gas_spent = b.gas_spent.saturating_sub(delta.unsigned_abs());
        }
    }

    /// Sums over the 30 days ending with `today`: (calls, revenue, gas spent).
    pub fn totals(&self, today: u32) -> (u64, u128, u128) {
        self.buckets
            .iter()
            .filter(|b| Self::in_window(b.day, today))
            .fold((0u64, 0u128, 0u128), |(c, r, g), b| {
                (c.saturating_add(b.calls), r.saturating_add(b.revenue), g.saturating_add(b.gas_spent))
            })
    }

    pub fn view(&self, today: u32) -> StatsView {
        let (calls, revenue, gas) = self.totals(today);
        let mut days: Vec<DayBucketView> = self
            .buckets
            .iter()
            .filter(|b| Self::in_window(b.day, today) && (b.calls > 0 || b.gas_spent > 0))
            .map(|b| DayBucketView {
                day: b.day,
                calls: b.calls,
                revenue: U128(b.revenue),
                gas_spent: U128(b.gas_spent),
            })
            .collect();
        days.sort_by_key(|b| b.day);
        StatsView {
            today,
            calls_30d: calls,
            revenue_30d: U128(revenue),
            gas_spent_30d: U128(gas),
            calls_total: self.calls_total,
            revenue_total: U128(self.revenue_total),
            days,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: u32 = 20_000;

    #[test]
    fn records_per_day() {
        let mut s = StatsRing::default();
        s.record_charge(D, 2, 200);
        s.record_charge(D, 1, 100);
        s.record_charge(D + 1, 5, 500);
        assert_eq!(s.totals(D + 1), (8, 800, 0));
        let v = s.view(D + 1);
        assert_eq!(v.days.len(), 2);
        assert_eq!(v.days[0].day, D);
        assert_eq!(v.days[1].calls, 5);
    }

    #[test]
    fn window_is_30_days() {
        let mut s = StatsRing::default();
        s.record_charge(D, 1, 100);
        assert_eq!(s.totals(D + 29).0, 1);
        assert_eq!(s.totals(D + 30).0, 0, "day falls out of the window");
        assert_eq!(s.calls_total, 1, "lifetime totals stay");
    }

    #[test]
    fn slot_reuse_resets_old_bucket() {
        let mut s = StatsRing::default();
        s.record_charge(D, 7, 700);
        s.record_charge(D + STAT_DAYS, 1, 100);
        assert_eq!(s.totals(D + STAT_DAYS), (1, 100, 0));
        assert_eq!(s.revenue_total, 800);
    }

    #[test]
    fn gas_refunds_net_out() {
        let mut s = StatsRing::default();
        s.record_gas(D, 1_000);
        s.record_gas(D, -300);
        s.record_gas(D, -5_000);
        assert_eq!(s.totals(D).2, 0, "never negative");
        s.record_gas(D, 50);
        assert_eq!(s.totals(D).2, 50);
    }

    #[test]
    fn future_buckets_are_ignored() {
        let mut s = StatsRing::default();
        s.record_charge(D + 3, 1, 100);
        assert_eq!(s.totals(D).0, 0);
    }
}
