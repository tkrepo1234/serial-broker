import type { Clock, TimerHandle } from '../core/clock.js';

/**
 * How much later than it was due a deadline may run before it is taken for one the tab could not
 * run in time.
 *
 * A browser runs timers late in three situations: a hidden tab's timers are aligned to whole seconds,
 * or to whole minutes after five minutes hidden; a frozen tab runs none until it resumes; and a
 * suspended machine runs none until it wakes. Only the first is routine, and it stays within a
 * second of the due time unless the tab has been hidden for long.
 */
export const LATE_DEADLINE_MS = 1_000;

/** A scheduled deadline. */
export interface Deadline {
  /** Stops the deadline. Safe to call after it expired, and more than once. */
  cancel(): void;
}

/**
 * Schedules `onExpired` after `delayMs`, and lets a deadline that runs late yield once first.
 *
 * A deadline decides from what a tab has heard: a write that no word of has arrived has not
 * started; a former owner that has said nothing more has gone. A tab that was frozen or asleep
 * resumes with its overdue timers and the messages that arrived meanwhile both queued, and the
 * browser promises no order between the two. Deciding at once may decide against a message that is
 * already waiting - failing a write that succeeded, or handing a written one to the next owner to be
 * written again (ADR-0013, ADR-0026).
 *
 * So a deadline that runs {@link LATE_DEADLINE_MS} or more late schedules itself once more with no
 * delay. That timer is queued behind the tasks already waiting, and those run first. A deadline that
 * runs on time decides at once, as before.
 *
 * Lateness is measured with `clock.now()`, which the system time can move. A wall clock set forward
 * makes a punctual deadline look late, and it yields once for nothing; a wall clock set back hides a
 * late one, which then decides at once, as without this.
 */
export function scheduleDeadline(clock: Clock, onExpired: () => void, delayMs: number): Deadline {
  const dueAt = clock.now() + delayMs;
  let handle: TimerHandle | undefined;

  const expire = (mayYield: boolean): void => {
    handle = undefined;
    if (mayYield && clock.now() - dueAt >= LATE_DEADLINE_MS) {
      handle = clock.setTimer(() => {
        expire(false);
      }, 0);
      return;
    }
    onExpired();
  };

  handle = clock.setTimer(() => {
    expire(true);
  }, delayMs);

  return {
    cancel: () => {
      if (handle !== undefined) {
        clock.clearTimer(handle);
        handle = undefined;
      }
    },
  };
}
