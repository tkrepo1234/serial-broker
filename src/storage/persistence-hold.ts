import { describeUnknown } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';
import { NAMESPACE } from '../protocol/version.js';

import { STORAGE_SCHEMA_VERSION } from './configuration-store.js';

/**
 * Name of the Web Lock every tab running a configuration with `remember: true` holds in shared mode,
 * to say across every tab of the origin that it still runs the configuration (ADR-0020).
 *
 * The remembered configurations are one entry per name for the whole origin, so a tab that releases
 * a configuration must not forget it while another tab still runs it: that tab would lose it on its
 * next reload. Each such tab holds this shared lock, and a releasing tab forgets the entry only if
 * it can take the lock exclusively - that is, when no tab holds it any more. The browser releases a
 * closed or crashed tab's locks, so a tab that went away never keeps an entry alive.
 *
 * Versioned with the stored format, not with the protocol: tabs on different protocol versions
 * share the stored configurations (ADR-0020), so they have to share this lock too. The
 * configuration name comes last, so that a name containing `/` cannot be mistaken for a version.
 */
export function persistenceLockName(configName: string): string {
  return `${NAMESPACE}/persisted/v${String(STORAGE_SCHEMA_VERSION)}/${configName}`;
}

/**
 * How many times to ask again after the browser said the lock was not available.
 *
 * "Not available" is not always the truth. A tab lets go of its own shared hold and asks for the
 * lock exclusively in the same breath; the withdrawn request can still be in the browser's queue
 * when the exclusive one arrives, and the browser then refuses a lock that nothing holds (measured
 * in Edge 153: the refusal comes a millisecond after the withdrawal). Each further attempt is made
 * after a round trip through `query()`, which gives the browser the turn it needs to drop the
 * withdrawn request - and says, on the way, whether a tab really holds it.
 */
const ATTEMPTS_AFTER_A_REFUSAL = 3;

/**
 * Runs `forget` unless a tab still holds the configuration's {@link persistenceLockName} lock.
 *
 * `forget` runs inside the exclusive lock, so no tab can take the hold - and save the entry again -
 * until it has finished. A tab that sets the configuration up meanwhile saves the entry at once,
 * before its hold is granted, and again once it is: whichever of the two comes after `forget` puts
 * the entry back.
 *
 * Where the browser refuses the request, nothing is forgotten: an entry kept too long is restored
 * once more, and one forgotten too early is lost for good.
 */
export async function forgetUnlessHeld(
  locks: LockManagerLike,
  configName: string,
  forget: () => void,
  logger: ScopedLogger,
): Promise<void> {
  const name = persistenceLockName(configName);
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (await underTheLock(locks, name, forget)) {
        return;
      }
      if (attempt >= ATTEMPTS_AFTER_A_REFUSAL || (await someoneHolds(locks, name))) {
        // A tab still runs it, which is what the lock is for: its entry stays. Or the browser
        // will not say, and an entry kept is better than one lost.
        logger.debug('a tab may still run this remembered configuration, so its entry stays', {
          configName,
          event: 'storage.hold-kept',
          attempts: attempt + 1,
        });
        return;
      }
    }
  } catch (error) {
    logger.warn('could not tell whether another tab still runs a remembered configuration', {
      configName,
      event: 'storage.hold-failed',
      error: describeUnknown(error),
    });
  }
}

/** Runs `forget` if the lock can be taken exclusively right now. Returns whether it was. */
async function underTheLock(
  locks: LockManagerLike,
  name: string,
  forget: () => void,
): Promise<boolean> {
  let granted = false;
  await locks.request(name, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (lock !== null) {
      forget();
      granted = true;
    }
    await Promise.resolve();
  });
  return granted;
}

/**
 * Whether a tab holds the lock, as the browser sees it.
 *
 * A request only queued is not a tab running the configuration - it may well be this tab's own,
 * withdrawn a moment ago. Where the browser does not offer `query()`, the refusal has to be taken
 * at its word.
 */
async function someoneHolds(locks: LockManagerLike, name: string): Promise<boolean> {
  if (locks.query === undefined) {
    return true;
  }
  const snapshot = await locks.query();
  return (snapshot.held ?? []).some((lock) => lock.name === name);
}
