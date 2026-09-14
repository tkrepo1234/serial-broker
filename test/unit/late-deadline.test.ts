import { describe, expect, it } from 'vitest';

import { LATE_DEADLINE_MS, scheduleDeadline } from '../../src/client/late-deadline.js';
import { FakeClock } from '../harness/fake-clock.js';

/**
 * A deadline that runs late lets the tasks already queued run before it decides. Another timer due
 * at the same moment, scheduled after the deadline, stands in for such a task: the browser runs it
 * before a timer scheduled later still.
 */
describe('scheduleDeadline', () => {
  function race(clock: FakeClock, wallClockJumpMs: number): Promise<string[]> {
    const order: string[] = [];
    scheduleDeadline(clock, () => order.push('deadline'), 100);
    clock.setTimer(() => order.push('queued task'), 100);
    clock.jumpWallClock(wallClockJumpMs);
    return clock.advance(100).then(() => order);
  }

  it('decides at once when it runs on time', async () => {
    expect(await race(new FakeClock(), 0)).toEqual(['deadline', 'queued task']);
  });

  it('decides at once when it runs a little late, as a hidden tab`s aligned timers do', async () => {
    expect(await race(new FakeClock(), LATE_DEADLINE_MS - 1)).toEqual(['deadline', 'queued task']);
  });

  it('lets the tasks already queued run first when it runs late', async () => {
    expect(await race(new FakeClock(), LATE_DEADLINE_MS)).toEqual(['queued task', 'deadline']);
  });

  it('yields only once, however late it is', async () => {
    const clock = new FakeClock();
    let expired = 0;
    scheduleDeadline(clock, () => (expired += 1), 100);
    clock.jumpWallClock(10 * LATE_DEADLINE_MS);

    await clock.advance(100);

    expect(expired).toBe(1);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('does not expire when cancelled while it yields', async () => {
    const clock = new FakeClock();
    let expired = false;
    const deadline = scheduleDeadline(clock, () => (expired = true), 100);
    clock.setTimer(() => {
      deadline.cancel();
    }, 100);
    clock.jumpWallClock(LATE_DEADLINE_MS);

    await clock.advance(100);

    expect(expired).toBe(false);
    expect(clock.pendingTimerCount).toBe(0);
  });
});
