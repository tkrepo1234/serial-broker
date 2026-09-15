import { describeUnknown } from '../core/errors.js';
import type { ScopedLogger } from '../core/logger.js';
import type { LockManagerLike } from '../environment/environment.js';

import { STORAGE_SCHEMA_VERSION } from './configuration-store.js';

/**
 * Name of the Web Lock every tab running a configuration with `remember: true` holds in shared mode,
 * to say across every tab of the origin that it still runs the configuration (ADR-0027).
 *
 * The remembered configurations are one entry per name for the whole origin, so a tab that releases
 * a configuration must not forget it while another tab still runs it: that tab would lose it on its
 * next reload. Each such tab holds this shared lock, and a releasing tab forgets the entry only if
 * it can take the lock exclusively - that is, when no tab holds it any more. The browser releases a
 * closed or crashed tab's locks, so a tab that went away never keeps an entry alive.
 *
 * Versioned with the stored format, not with the protocol: tabs on different protocol versions
 * share the stored configurations (ADR-0022), so they have to share this lock too. The
 * configuration name comes last, so that a name containing `/` cannot be mistaken for a version.
 */
export function persistenceLockName(configName: string): string {
  return `serial-broker/persisted/v${String(STORAGE_SCHEMA_VERSION)}/${configName}`;
}

/**
 * Runs `forget` unless a tab still holds the configuration's {@link persistenceLockName} lock.
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
