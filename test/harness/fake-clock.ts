import type { Clock, TimerHandle } from '../../src/core/clock.js';

interface ScheduledTimer {
  readonly id: number;
  readonly dueAt: number;
  readonly callback: () => void;
  readonly sequence: number;
}

/**
 * A clock whose time only moves when a test says so.
 *
 * Reconnect backoff, write deadlines and ownership-transfer grace periods are all measured in
 * milliseconds that would otherwise have to be waited out. Controlling time turns "wait 30
 * seconds and hope" into an exact assertion, and it is the difference between a test suite
 * that runs in 200 ms and one nobody runs.
 *
 * Ties are broken by scheduling order, matching how browsers resolve timers due in the same
 * millisecond. Without that rule a test could pass or fail on `Map` iteration order.
 */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 1;
  #sequence = 0;
  #timers = new Map<number, ScheduledTimer>();

  constructor(startAt = 1_700_000_000_000) {
    this.#now = startAt;
  }

  /** {@inheritDoc Clock.now} */
  now(): number {
    return this.#now;
  }

  /** {@inheritDoc Clock.setTimer} */
  setTimer(callback: () => void, delayMs: number): TimerHandle {
    const id = this.#nextId++;
    this.#sequence += 1;
    this.#timers.set(id, {
      id,
      dueAt: this.#now + Math.max(0, delayMs),
      callback,
      sequence: this.#sequence,
    });
    return id;
  }

  /** {@inheritDoc Clock.clearTimer} */
  clearTimer(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  /** Number of timers still scheduled. A test asserting on cleanup checks this is zero. */
  get pendingTimerCount(): number {
    return this.#timers.size;
  }

  /** Milliseconds until the next timer is due, or `undefined` if none is scheduled. */
  get nextTimerInMs(): number | undefined {
    let earliest: number | undefined;
    for (const timer of this.#timers.values()) {
      if (earliest === undefined || timer.dueAt < earliest) {
        earliest = timer.dueAt;
      }
    }
    return earliest === undefined ? undefined : earliest - this.#now;
  }

  /**
   * Advances time, firing every timer that falls due.
   *
   * Timers scheduled *by* a firing timer are honoured if they also fall within the window,
   * which is what makes a backoff sequence testable in one call. The iteration is bounded, so
   * a timer that reschedules itself with a zero delay fails the test rather than hanging it.
   */
  async advance(byMs: number): Promise<void> {
    const target = this.#now + byMs;
    let iterations = 0;

    for (;;) {
      const due = [...this.#timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.sequence - b.sequence);

      const next = due[0];
      if (next === undefined) {
        break;
      }

      iterations += 1;
      if (iterations > 10_000) {
        throw new Error('FakeClock.advance: timer storm - a timer is rescheduling itself');
      }

      this.#now = next.dueAt;
      this.#timers.delete(next.id);
      next.callback();

      // Timer callbacks in this library start promise chains. Letting the microtask queue
      // drain here is what makes `advance` behave like real elapsed time rather than like a
      // synchronous loop that outruns its own continuations.
      await flushMicrotasks();
    }

    this.#now = target;
    await flushMicrotasks();
  }

  /** Advances exactly to the next due timer. Used to step through a sequence one at a time. */
  async advanceToNextTimer(): Promise<void> {
    const delay = this.nextTimerInMs;
    if (delay === undefined) {
      await flushMicrotasks();
      return;
    }
    await this.advance(delay);
  }
}

/**
 * Lets every already-queued microtask run.
 *
 * `await Promise.resolve()` yields exactly one microtask tick, which is not enough for the
 * chains this library builds (a lock grant that starts an open that starts a read loop).
 * Several rounds through the macrotask queue drains them all without depending on a count.
 */
export async function flushMicrotasks(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}
