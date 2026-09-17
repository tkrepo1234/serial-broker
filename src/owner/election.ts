import type { Clock } from '../core/clock.js';
import { describeUnknown } from '../core/errors.js';
import { HeldLock } from '../core/held-lock.js';
import type { ScopedLogger } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';
import type { TermId } from '../protocol/messages.js';
import { ownerLockName } from '../protocol/version.js';

/** What the election asks of the context taking part, and tells it. */
export interface ElectionCallbacks {
  /** A new term of holding the port, and the name of its lock (ADR-0018). */
  readonly newTerm: () => { readonly term: TermId; readonly lockName: string };
  /**
   * This context now holds the port in `term`: the ownership lock and the term's lock are held.
   *
   * Invoked synchronously from inside the term lock's callback, so anything it starts is already
   * protected by both locks.
   */
  readonly onAcquired: (term: TermId) => void;
  /** This context no longer holds the port. Invoked after both locks have been let go. */
  readonly onLost: () => void;
}

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
 * Inside the ownership lock the context takes the lock of a new term before it counts as the owner,
 * so that nothing is said in a term whose lock is not held (ADR-0018). A term lock the browser
 * refuses lets the ownership lock go as well, and both are requested again after a pause: there is
 * no state in which a context holds the ownership lock without a term.
 *
 * See ADR-0005.
 */
export class OwnershipElection {
  readonly #lock: HeldLock;
  #isOwner = false;
  #isStopped = false;

  constructor(
    locks: LockManagerLike,
    configName: string,
    callbacks: ElectionCallbacks,
    logger: ScopedLogger,
    clock: Clock,
  ) {
    this.#lock = new HeldLock({
      locks,
      clock,
      name: ownerLockName(configName),
      mode: 'exclusive',
      hold: async (released) => {
        const { term, lockName } = callbacks.newTerm();
        await locks.request(lockName, { mode: 'exclusive' }, async () => {
          // Stopped while the term's lock was being granted: returning lets both go at once.
          if (this.#isStopped) {
            return;
          }
          this.#isOwner = true;
          logger.info('acquired port ownership', { configName, event: 'election.acquired' });
          callbacks.onAcquired(term);
          // Holding the locks means keeping this promise pending. This is the whole mechanism.
          await released;
        });
      },
      onFailed: (error) => {
        logger.warn('ownership request failed', {
          configName,
          event: 'election.failed',
          // Not `String(error)`, which throws for an error whose name or message cannot be read.
          error: describeUnknown(error),
        });
      },
      onEnded: () => {
        if (this.#isOwner) {
          this.#isOwner = false;
          logger.info('released port ownership', { configName, event: 'election.released' });
          callbacks.onLost();
        }
      },
    });
  }

  /** `true` while this context holds the lock. */
  get isOwner(): boolean {
    return this.#isOwner;
  }

  /**
   * Joins the election and stays in it. Returns immediately; a no-op while participating, or after
   * {@link stop}.
   */
  start(): void {
    this.#lock.start();
  }

  /**
   * Leaves the election, releasing the locks if this context holds them. Safe to call at any point.
   *
   * @returns Settles once the browser has let the locks go.
   */
  async stop(): Promise<void> {
    this.#isStopped = true;
    await this.#lock.stop();
  }
}
