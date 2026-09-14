/**
 * The time-dependent part of the environment, injected so that every delay in this library is
 * controllable from a test. See ADR-0014.
 */
export interface Clock {
  /**
   * Epoch milliseconds: what the system clock says, jumps and all.
   *
   * The time of an event, for a timestamp an operator reads or another tab compares with its own
   * records. Never the time a duration is measured with - see {@link Clock.monotonicNow} and
   * ADR-0032.
   */
  now(): number;
  /**
   * Milliseconds on a clock that only counts forward, from an origin that means nothing on its own.
   *
   * The difference of two readings is an elapsed time; a single reading says nothing and belongs in
   * no message, record or report. Timers run on this clock, so a duration measured with it and a
   * timer waiting for it agree even when the user, a time zone change or an NTP step moves the
   * system clock. See ADR-0032.
   */
  monotonicNow(): number;
  /** Schedules `callback` after `delayMs`, returning a handle for {@link Clock.clearTimer}. */
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  /** Cancels a scheduled callback. Safe to call with an already-fired handle. */
  clearTimer(handle: TimerHandle): void;
}

/** Opaque handle returned by {@link Clock.setTimer}. */
export type TimerHandle = number | object;

/** Generates opaque identifiers for clients and requests. */
export type IdGenerator = (prefix: string) => string;
