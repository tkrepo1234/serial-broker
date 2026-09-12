import { describe, expect, it } from 'vitest';

import { BackoffState, computeBackoffDelayMs } from '../../src/core/backoff.js';
import { DEFAULT_CONNECTION_SETTINGS } from '../../src/core/defaults.js';

const SETTINGS = {
  initialDelayMs: 250,
  factor: 2,
  maxDelayMs: 30_000,
  jitter: 0.5,
  maxAttempts: Number.POSITIVE_INFINITY,
};

/** Returns a fixed draw, so a jittered delay becomes an exact number. */
const fixedRandom = (value: number) => (): number => value;

describe('computeBackoffDelayMs', () => {
  it('does not delay the first retry', () => {
    expect(computeBackoffDelayMs(0, SETTINGS, fixedRandom(0))).toBe(0);
  });

  it('grows by the configured factor', () => {
    const delays = [1, 2, 3, 4].map((attempt) =>
      computeBackoffDelayMs(attempt, SETTINGS, fixedRandom(1)),
    );

    expect(delays).toEqual([250, 500, 1000, 2000]);
  });

  it('never exceeds the ceiling, however many attempts have failed', () => {
    const delay = computeBackoffDelayMs(50, SETTINGS, fixedRandom(1));

    // 250 * 2^49 overflows well past any sensible number; the cap has to survive that.
    expect(delay).toBe(SETTINGS.maxDelayMs);
    expect(Number.isFinite(delay)).toBe(true);
  });

  it('draws between the jitter floor and the full delay', () => {
    const floor = computeBackoffDelayMs(1, SETTINGS, fixedRandom(0));
    const ceiling = computeBackoffDelayMs(1, SETTINGS, fixedRandom(1));

    // Full jitter with a floor of 0.5: a draw of 0 gives half the delay, a draw of 1 gives
    // all of it. Without this spread, several tabs retry in lockstep forever.
    expect(floor).toBe(125);
    expect(ceiling).toBe(250);
  });

  it('collapses to a fixed delay when jitter is disabled', () => {
    const settings = { ...SETTINGS, jitter: 1 };

    expect(computeBackoffDelayMs(2, settings, fixedRandom(0))).toBe(500);
    expect(computeBackoffDelayMs(2, settings, fixedRandom(0.99))).toBe(500);
  });

  it('never returns a negative delay', () => {
    const delay = computeBackoffDelayMs(-5, SETTINGS, fixedRandom(0));

    expect(delay).toBe(0);
  });
});

describe('BackoffState', () => {
  it('counts attempts', () => {
    const state = new BackoffState();

    state.recordAttempt();
    state.recordAttempt();

    expect(state.attempt).toBe(2);
  });

  it('reports exhaustion once the attempt count reaches the limit', () => {
    const state = new BackoffState();
    const settings = { ...SETTINGS, maxAttempts: 2 };

    state.recordAttempt();
    expect(state.hasExhausted(settings)).toBe(false);
    state.recordAttempt();
    expect(state.hasExhausted(settings)).toBe(true);
  });

  it('resets the counter after a connection that held long enough', () => {
    const state = new BackoffState();
    state.recordAttempt();
    state.recordAttempt();

    state.recordConnected(1_000);
    state.recordDisconnected(1_000 + DEFAULT_CONNECTION_SETTINGS.stableAfterMs, 5_000);

    expect(state.attempt).toBe(0);
  });

  it('keeps the counter when a connection drops again immediately', () => {
    const state = new BackoffState();
    state.recordAttempt();
    state.recordAttempt();

    state.recordConnected(1_000);
    state.recordDisconnected(1_100, 5_000);

    // A device that accepts open() and drops straight back out would otherwise loop at the
    // initial delay forever, hammering a device that is plainly not well.
    expect(state.attempt).toBe(2);
  });

  it('does not reset on a disconnect with no preceding connection', () => {
    const state = new BackoffState();
    state.recordAttempt();

    state.recordDisconnected(10_000, 0);

    expect(state.attempt).toBe(1);
  });
});
