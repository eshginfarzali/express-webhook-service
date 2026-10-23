/**
 * Pure retry / backoff math. No I/O, no clock, no global randomness:
 * every input (including `now` and the random source) is passed in, which
 * keeps the schedule fully deterministic under test.
 */

export type JitterStrategy = 'full' | 'equal' | 'none';

export interface RetryPolicy {
  /** Total number of attempts, including the first one. */
  readonly maxAttempts: number;
  /** Delay before the first retry (attempt 2), before jitter. */
  readonly baseDelayMs: number;
  /** Upper bound for any single delay. */
  readonly maxDelayMs: number;
  readonly jitter: JitterStrategy;
}

/** Returns a float in [0, 1). */
export type RandomSource = () => number;

export type RetryDecision =
  | { readonly kind: 'retry'; readonly delayMs: number; readonly nextAttemptAt: number }
  | { readonly kind: 'dead_letter'; readonly reason: 'max_attempts_exhausted' | 'non_retryable' };

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, received ${value}`);
  }
}

/**
 * Exponential delay without jitter for the retry that follows `failedAttempt`:
 * `min(maxDelayMs, baseDelayMs * 2^(failedAttempt - 1))`.
 */
export function exponentialDelay(failedAttempt: number, policy: RetryPolicy): number {
  assertPositiveInteger(failedAttempt, 'failedAttempt');
  // Clamp the exponent so 2^n never overflows to Infinity for large attempt numbers.
  const exponent = Math.min(failedAttempt - 1, 52);
  return Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
}

/**
 * Delay with jitter applied (see "Exponential Backoff And Jitter", AWS Architecture Blog):
 * - `full`:  uniform in [0, cap)
 * - `equal`: cap/2 + uniform in [0, cap/2)
 * - `none`:  cap
 */
export function backoffDelay(
  failedAttempt: number,
  policy: RetryPolicy,
  random: RandomSource = Math.random,
): number {
  const cap = exponentialDelay(failedAttempt, policy);
  switch (policy.jitter) {
    case 'none':
      return cap;
    case 'full':
      return Math.floor(sample(random) * cap);
    case 'equal': {
      const half = cap / 2;
      return Math.floor(half + sample(random) * half);
    }
  }
}

function sample(random: RandomSource): number {
  const value = random();
  if (!(value >= 0 && value < 1)) {
    throw new RangeError(`random source must return a value in [0, 1), received ${value}`);
  }
  return value;
}

/**
 * Decides what happens after attempt number `failedAttempt` (1-based) failed.
 */
export function decideAfterFailure(
  failedAttempt: number,
  policy: RetryPolicy,
  now: number,
  options: { readonly retryable?: boolean; readonly random?: RandomSource } = {},
): RetryDecision {
  assertPositiveInteger(failedAttempt, 'failedAttempt');
  if (options.retryable === false) {
    return { kind: 'dead_letter', reason: 'non_retryable' };
  }
  if (failedAttempt >= policy.maxAttempts) {
    return { kind: 'dead_letter', reason: 'max_attempts_exhausted' };
  }
  const delayMs = backoffDelay(failedAttempt, policy, options.random);
  return { kind: 'retry', delayMs, nextAttemptAt: now + delayMs };
}

/**
 * The un-jittered delay before each retry, i.e. the upper bound of every
 * jittered delay. Length is `maxAttempts - 1`.
 */
export function backoffSchedule(policy: RetryPolicy): number[] {
  assertPositiveInteger(policy.maxAttempts, 'maxAttempts');
  return Array.from({ length: policy.maxAttempts - 1 }, (_, index) =>
    exponentialDelay(index + 1, policy),
  );
}
