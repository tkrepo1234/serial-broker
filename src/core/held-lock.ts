import type { LockManagerLike } from '../environment/environment.js';

import type { Clock, TimerHandle } from './clock.js';
import { createSignal } from './deadline.js';
import { isAbortError } from './errors.js';

/**
 * How long to wait before requesting a lock again after the browser refused the request.
 *
 * A request the browser refuses outright would otherwise be repeated in an endless chain of
 * microtasks that freezes the tab.
 */
export const LOCK_RETRY_DELAY_MS = 1_000;

/** What a {@link HeldLock} does with its lock. */
export interface HeldLockOptions {
  readonly locks: LockManagerLike;
  readonly clock: Clock;
  readonly name: string;
  readonly mode: 'exclusive' | 'shared';
  /**
   * Runs once the lock is granted. The lock is held until the returned promise settles; `released`
   * resolves when {@link HeldLock.stop} is called. A rejection lets the lock go and counts as a
   * refused request.
   */
  readonly hold: (released: Promise<void>) => Promise<void>;
  /** The request was refused, or `hold` failed. The lock is requested again after a pause. */
  readonly onFailed: (error: unknown) => void;
  /** The request has ended, however it ended: the lock was let go, aborted or refused. */
  readonly onEnded?: () => void;
}

/**
 * A Web Lock requested and held for as long as the context wants it.
 *
 * Every lock this library keeps follows the same pattern: request it with an abort signal, hold it
 * on a promise, let it go by resolving that promise or by aborting a request still queued, and
 * request it again after a pause when the browser refuses. The browser lets go of a context's locks
 * when the context dies, however it dies, so nothing has to notice a death (ADR-0005).
 */
export class HeldLock {
  #isStopped = false;
  #abort: AbortController | undefined;
  #release = createSignal();
  #retry: TimerHandle | undefined;
  /** Settles once the current request has ended. */
  #ended: Promise<void> = Promise.resolve();

  constructor(private readonly options: HeldLockOptions) {}

  /** Requests the lock, unless it is requested already or the lock was stopped. Returns at once. */
  start(): void {
    if (this.#isStopped || this.#abort !== undefined) {
      return;
    }
    const { locks, clock, name, mode, hold, onFailed, onEnded } = this.options;
    const abort = new AbortController();
    this.#abort = abort;

    this.#ended = locks
      .request(name, { mode, signal: abort.signal }, async () => {
        // Granted after `stop()`: returning lets the lock go at once.
        if (!this.#isStopped) {
          await hold(this.#release.promise);
        }
      })
      .then(
        () => undefined,
        (error: unknown) => {
          if (isAbortError(error) || this.#isStopped) {
            return;
          }
          onFailed(error);
          this.#retry = clock.setTimer(() => {
            this.#retry = undefined;
            this.start();
          }, LOCK_RETRY_DELAY_MS);
        },
      )
      .finally(() => {
        this.#abort = undefined;
        onEnded?.();
      });
  }

  /**
   * Lets the lock go, or withdraws the request, and never requests it again.
   *
   * @returns Settles once the browser has let the lock go.
   */
  async stop(): Promise<void> {
    if (!this.#isStopped) {
      this.#isStopped = true;
      if (this.#retry !== undefined) {
        this.options.clock.clearTimer(this.#retry);
        this.#retry = undefined;
      }
      this.#release.resolve();
      this.#abort?.abort();
    }
    await this.#ended;
  }
}
