import type { Clock, TimerHandle } from '../core/clock.js';
import { createSignal, type Signal } from '../core/deadline.js';
import { describeUnknown, isAbortError } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';
import { ownerLockName } from '../protocol/version.js';

/** Called when this context becomes, or stops being, the owner. */
export interface ElectionCallbacks {
  /**
   * This context now holds the port.
   *
   * Invoked synchronously from inside the lock callback, so anything it starts is already
   * protected by the lock.
   */
  readonly onAcquired: () => void;
  /**
   * This context no longer holds the port.
   *
   * Invoked after the lock has been released, whether that was requested or not.
   */
  readonly onLost: () => void;
}

/** How long to wait before requesting the lock again after a request failed. */
export const ELECTION_RETRY_DELAY_MS = 1_000;

/**
 * Elects exactly one context to own a configuration's port.
 *
 * Ownership *is* holding the Web Lock named for the configuration - there is no separate flag
 * that could disagree with it, no heartbeat, and no timeout. The browser grants the lock to
 * one context at a time and releases it when that context dies, however it dies: a closed
 * tab, a crashed renderer, an out-of-memory kill, a laptop lid. The next queued context is
 * granted it immediately.
 *
 * Every context with the configuration set up keeps a request outstanding, so a successor is
 * always queued and failover needs no cooperation from the context that disappeared.
 *
 * See ADR-0005.
 */
export class OwnershipElection {
  #abort: AbortController | undefined;
  #release: Signal | undefined;
  #isOwner = false;
  #isStopped = false;
  #retryTimer: TimerHandle | undefined;

  constructor(
    private readonly locks: LockManagerLike,
    private readonly configName: string,
    private readonly callbacks: ElectionCallbacks,
    private readonly logger: ScopedLogger,
    private readonly clock: Clock,
  ) {}

  /** `true` while this context holds the lock. */
  get isOwner(): boolean {
    return this.#isOwner;
  }

  /**
   * Joins the election and stays in it.
   *
   * Returns immediately. If the lock is free this context becomes the owner in a microtask;
   * otherwise it waits, without polling, until whoever holds it lets go.
   *
   * Calling this while already participating, or after {@link stop}, is a no-op.
   */
  start(): void {
    if (this.#abort !== undefined || this.#isStopped) {
      return;
    }

    const abort = new AbortController();
    this.#abort = abort;

    const lockName = ownerLockName(this.configName);

    void this.locks
      .request(lockName, { mode: 'exclusive', signal: abort.signal }, async () => {
        // The browser grants the lock and runs this callback in separate steps. A `stop()` in
        // between found no release to resolve and a request its abort no longer affects, so this
        // is the last place to notice it: returning lets the lock go at once, where waiting would
        // hold it until the tab closes.
        if (this.#isStopped) {
          return;
        }

        // Granted. Everything from here until `release` resolves runs with exclusive
        // ownership of this configuration, guaranteed by the browser rather than by us.
        const release = createSignal();
        this.#release = release;
        this.#isOwner = true;

        this.logger.info('acquired port ownership', {
          configName: this.configName,
          event: 'election.acquired',
        });

        this.callbacks.onAcquired();

        // Holding the lock means keeping this promise pending. This is the whole mechanism.
        await release.promise;
      })
      .then(
        () => {
          this.#afterRelease('released');
        },
        (error: unknown) => {
          // An aborted request is the normal path when a configuration is released before the
          // lock was ever granted; it is not a failure.
          if (isAbortError(error)) {
            this.#afterRelease('aborted');
            return;
          }

          this.logger.warn('ownership request failed', {
            configName: this.configName,
            event: 'election.failed',
            // Not `String(error)`, which throws for an error whose name or message cannot be read:
            // this handler would then never rejoin, leaving the context out of the election.
            error: describeUnknown(error),
          });
          this.#afterRelease('failed');
        },
      );
  }

  /**
   * Leaves the election, releasing the lock if this context holds it.
   *
   * Safe to call at any point: while queued (the request is aborted), while holding (the lock
   * is released and the successor is granted it), or after having already stopped.
   */
  stop(): void {
    if (this.#isStopped) {
      return;
    }
    this.#isStopped = true;
    if (this.#retryTimer !== undefined) {
      this.clock.clearTimer(this.#retryTimer);
      this.#retryTimer = undefined;
    }

    // Order matters: resolving the release lets the lock go, aborting only affects a request
    // still queued. Doing both covers either state without having to know which we are in.
    this.#release?.resolve();
    this.#abort?.abort();
  }

  #afterRelease(reason: 'released' | 'aborted' | 'failed'): void {
    const wasOwner = this.#isOwner;
    this.#isOwner = false;
    this.#release = undefined;
    this.#abort = undefined;

    if (wasOwner) {
      this.logger.info('released port ownership', {
        configName: this.configName,
        event: 'election.released',
        reason,
      });
      this.callbacks.onLost();
    }

    // A request that failed for a reason other than being aborted leaves this context out of
    // the election entirely, which would silently make it ineligible to ever own the port.
    // Rejoining is the only safe response; `start` is a no-op if we have been stopped.
    if (reason === 'failed' && !this.#isStopped) {
      // After a pause: a request the browser refuses outright would otherwise be repeated in an
      // endless chain of microtasks that freezes the tab.
      this.#retryTimer = this.clock.setTimer(() => {
        this.#retryTimer = undefined;
        this.start();
      }, ELECTION_RETRY_DELAY_MS);
    }
  }
}
