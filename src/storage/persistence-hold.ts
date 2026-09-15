import type { Clock, TimerHandle } from '../core/clock.js';
import { createSignal, type Signal } from '../core/deadline.js';
import { describeUnknown } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';

import { STORAGE_SCHEMA_VERSION } from './configuration-store.js';

/** How long to wait before requesting the hold again after the browser refused the request. */
export const PERSISTENCE_HOLD_RETRY_DELAY_MS = 1_000;

/**
 * Name of the Web Lock every tab running a configuration with `remember: true` holds in shared mode.
 *
 * Versioned with the stored format, not with the protocol: tabs on different protocol versions
 * share the stored configurations (ADR-0022), so they have to share this lock too. The
 * configuration name comes last, so that a name containing `/` cannot be mistaken for a version.
 */
export function persistenceLockName(configName: string): string {
  return `serial-broker/persisted/v${String(STORAGE_SCHEMA_VERSION)}/${configName}`;
}

/**
 * Says, across every tab of the origin, that this tab still runs a remembered configuration
 * (ADR-0027).
 *
 * The remembered configurations are one entry per name for the whole origin, so a tab that releases
 * a configuration must not forget it while another tab still runs it: that tab would lose it on its
 * next reload. Each such tab holds this shared lock, and a releasing tab forgets the entry only if
 * it can take the lock exclusively - that is, when no tab holds it any more. The browser releases a
 * closed or crashed tab's locks, so a tab that went away never keeps an entry alive, and nothing has
 * to notice that it went.
 */
export class PersistenceHold {
  #isStopped = false;
  #release: Signal | undefined;
  #abort: AbortController | undefined;
  #retryTimer: TimerHandle | undefined;
  /** Settles once the lock request has ended: aborted, or granted and let go. */
  #ended: Promise<void> = Promise.resolve();

  /**
   * @param onHeld - Called once the hold is granted, from inside the lock callback. The tab saves
   *   its configuration again there: a tab that forgot the entry while this request was queued
   *   behind its exclusive check has finished forgetting by then.
   */
  constructor(
    private readonly locks: LockManagerLike,
    private readonly configName: string,
    private readonly onHeld: () => void,
    private readonly logger: ScopedLogger,
    private readonly clock: Clock,
  ) {}

  /** Requests the hold. Returns at once. */
  start(): void {
    if (this.#isStopped || this.#abort !== undefined) {
      return;
    }
    const abort = new AbortController();
    this.#abort = abort;

    this.#ended = this.locks
      .request(
        persistenceLockName(this.configName),
        { mode: 'shared', signal: abort.signal },
        async () => {
          if (this.#isStopped) {
            return;
          }
          const release = createSignal();
          this.#release = release;
          this.onHeld();
          await release.promise;
        },
      )
      .then(
        () => undefined,
        (error: unknown) => {
          if (isAbortLike(error) || this.#isStopped) {
            return;
          }
          this.logger.warn('requesting the hold on a remembered configuration failed', {
            configName: this.configName,
            event: 'storage.hold-failed',
            error: describeUnknown(error),
          });
          // After a pause: a request the browser refuses outright would otherwise be repeated in
          // an endless chain of microtasks.
          this.#retryTimer = this.clock.setTimer(() => {
            this.#retryTimer = undefined;
            this.start();
          }, PERSISTENCE_HOLD_RETRY_DELAY_MS);
        },
      )
      .finally(() => {
        if (this.#abort === abort) {
          this.#abort = undefined;
        }
      });
  }

  /**
   * Gives the hold up, and resolves once the browser has let it go.
   *
   * Waiting matters: a tab that checks whether anyone still runs the configuration straight after
   * would otherwise find its own hold.
   */
  async stop(): Promise<void> {
    if (!this.#isStopped) {
      this.#isStopped = true;
      if (this.#retryTimer !== undefined) {
        this.clock.clearTimer(this.#retryTimer);
        this.#retryTimer = undefined;
      }
      this.#release?.resolve();
      this.#abort?.abort();
    }
    await this.#ended;
  }
}

/**
 * Runs `forget` unless a tab still holds the configuration's {@link PersistenceHold}.
 *
 * `forget` runs inside the exclusive lock, so no tab can take the hold - and save the entry again -
 * until it has finished. A tab that sets the configuration up meanwhile saves the entry at once,
 * before its hold is granted, and again once it is: whichever of the two comes after `forget` puts
 * the entry back.
 *
 * @returns Whether `forget` ran. Where the browser refuses the request, nothing is forgotten: an
 *   entry kept too long is restored once more, and one forgotten too early is lost for good.
 */
export async function forgetUnlessHeld(
  locks: LockManagerLike,
  configName: string,
  forget: () => void,
  logger: ScopedLogger,
): Promise<boolean> {
  try {
    return await locks.request(
      persistenceLockName(configName),
      { mode: 'exclusive', ifAvailable: true },
      async (lock) => {
        if (lock === null) {
          return false;
        }
        forget();
        return await Promise.resolve(true);
      },
    );
  } catch (error) {
    logger.warn('could not tell whether another tab still runs a remembered configuration', {
      configName,
      event: 'storage.hold-failed',
      error: describeUnknown(error),
    });
    return false;
  }
}

function isAbortLike(error: unknown): boolean {
  try {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError'
    );
  } catch {
    return false;
  }
}
