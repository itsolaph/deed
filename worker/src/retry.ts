// Retry policy of the delivery engine.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Delay before retry n (n = 1 is the first retry): 1 s, 5 s, 30 s, 2 min, 10 min, then hourly. */
export const RETRY_DELAYS_MS = [1 * SECOND, 5 * SECOND, 30 * SECOND, 2 * MINUTE, 10 * MINUTE];
export const HOURLY_MS = HOUR;
/** No new attempt starts later than this after acceptance. */
export const GIVE_UP_AFTER_MS = 24 * HOUR;
const JITTER = 0.2;

export type Outcome = "delivered" | "permanent" | "retry";

/** 2xx delivered; 4xx other than 408 and 429 permanent; anything else (5xx, 3xx left over,
 * timeouts, connection errors) is retried. */
export function classify(status: number): Outcome {
  if (status >= 200 && status < 300) return "delivered";
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return "permanent";
  return "retry";
}

export function retryDelayMs(retry: number, schedule: number[] = RETRY_DELAYS_MS, hourly = HOURLY_MS, random: () => number = Math.random): number {
  const base = schedule[retry - 1] ?? hourly;
  const factor = 1 + (random() * 2 - 1) * JITTER;
  return Math.round(base * factor);
}

/** Time of the next attempt, or null when the delivery should give up. */
export function nextAttemptAt(opts: {
  acceptedAt: number;
  now: number;
  attemptsMade: number;
  schedule?: number[];
  hourlyMs?: number;
  giveUpAfterMs?: number;
  random?: () => number;
}): number | null {
  const at = opts.now + retryDelayMs(opts.attemptsMade, opts.schedule, opts.hourlyMs, opts.random);
  return at - opts.acceptedAt > (opts.giveUpAfterMs ?? GIVE_UP_AFTER_MS) ? null : at;
}
