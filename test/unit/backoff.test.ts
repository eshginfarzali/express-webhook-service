import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  backoffSchedule,
  decideAfterFailure,
  exponentialDelay,
  type RetryPolicy,
} from '../../src/retry/backoff.js';

const policy: RetryPolicy = {
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
  jitter: 'none',
};

describe('exponentialDelay', () => {
  it('doubles the base delay for each failed attempt', () => {
    expect([1, 2, 3, 4].map((attempt) => exponentialDelay(attempt, policy))).toEqual([
      1_000, 2_000, 4_000, 8_000,
    ]);
  });

  it('caps the delay at maxDelayMs', () => {
    expect(exponentialDelay(5, policy)).toBe(10_000);
    expect(exponentialDelay(50, policy)).toBe(10_000);
  });

  it('does not overflow for very large attempt numbers', () => {
    expect(exponentialDelay(10_000, { ...policy, maxDelayMs: Number.MAX_SAFE_INTEGER })).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid attempt %s', (attempt) => {
    expect(() => exponentialDelay(attempt, policy)).toThrow(RangeError);
  });
});

describe('backoffSchedule', () => {
  it('lists the un-jittered delay before every retry', () => {
    expect(backoffSchedule(policy)).toEqual([1_000, 2_000, 4_000, 8_000, 10_000]);
  });

  it('is empty when only one attempt is allowed', () => {
    expect(backoffSchedule({ ...policy, maxAttempts: 1 })).toEqual([]);
  });
});

describe('backoffDelay', () => {
  it('returns the exact cap without jitter', () => {
    expect(backoffDelay(3, policy, () => 0.5)).toBe(4_000);
  });

  it('applies full jitter: uniform in [0, cap)', () => {
    const full = { ...policy, jitter: 'full' } as const;
    expect(backoffDelay(3, full, () => 0)).toBe(0);
    expect(backoffDelay(3, full, () => 0.25)).toBe(1_000);
    expect(backoffDelay(3, full, () => 0.999_999)).toBe(3_999);
  });

  it('applies equal jitter: cap/2 + uniform in [0, cap/2)', () => {
    const equal = { ...policy, jitter: 'equal' } as const;
    expect(backoffDelay(3, equal, () => 0)).toBe(2_000);
    expect(backoffDelay(3, equal, () => 0.5)).toBe(3_000);
    expect(backoffDelay(3, equal, () => 0.999_999)).toBe(3_999);
  });

  it('keeps jittered delays within bounds for any random value', () => {
    const full = { ...policy, jitter: 'full' } as const;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const cap = exponentialDelay(attempt, policy);
      for (let i = 0; i < 200; i += 1) {
        const delay = backoffDelay(attempt, full);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(cap);
      }
    }
  });

  it.each([1, -0.1, Number.NaN])('rejects a random source returning %s', (value) => {
    expect(() => backoffDelay(1, { ...policy, jitter: 'full' }, () => value)).toThrow(RangeError);
  });
});

describe('decideAfterFailure', () => {
  const now = 1_700_000_000_000;

  it('schedules a retry with the backoff delay while attempts remain', () => {
    expect(decideAfterFailure(2, policy, now)).toEqual({
      kind: 'retry',
      delayMs: 2_000,
      nextAttemptAt: now + 2_000,
    });
  });

  it('uses the injected random source for jitter', () => {
    const decision = decideAfterFailure(1, { ...policy, jitter: 'full' }, now, {
      random: () => 0.5,
    });
    expect(decision).toEqual({ kind: 'retry', delayMs: 500, nextAttemptAt: now + 500 });
  });

  it('dead-letters once the last allowed attempt has failed', () => {
    expect(decideAfterFailure(6, policy, now)).toEqual({
      kind: 'dead_letter',
      reason: 'max_attempts_exhausted',
    });
  });

  it('dead-letters immediately for non-retryable failures', () => {
    expect(decideAfterFailure(1, policy, now, { retryable: false })).toEqual({
      kind: 'dead_letter',
      reason: 'non_retryable',
    });
  });

  it('never retries when maxAttempts is 1', () => {
    expect(decideAfterFailure(1, { ...policy, maxAttempts: 1 }, now).kind).toBe('dead_letter');
  });
});
