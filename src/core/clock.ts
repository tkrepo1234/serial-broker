/**
 * The time-dependent part of the environment, injected so that every delay in this library is
 * controllable from a test. See ADR-0014.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
  /** Schedules `callback` after `delayMs`, returning a handle for {@link Clock.clearTimer}. */
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  /** Cancels a scheduled callback. Safe to call with an already-fired handle. */
  clearTimer(handle: TimerHandle): void;
}

/** Opaque handle returned by {@link Clock.setTimer}. */
export type TimerHandle = number | object;

/** Generates opaque identifiers for clients and requests. */
export type IdGenerator = (prefix: string) => string;
