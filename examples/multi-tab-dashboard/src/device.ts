/**
 * The one configuration this dashboard uses, and the calls that set it up, restore it and let
 * it go. Everything here is plain serial-broker; nothing knows about the page.
 */

import {
  SerialBroker,
  SerialBrokerError,
  SerialBrokerErrorCode,
  type Logger,
  type SerialBrokerOptions,
} from 'serial-broker';
// Vite serves the file this URL names from this application's own origin, and in a production
// build copies it into `dist/assets/` under a hashed name. That is what the library needs: a
// `SharedWorker` is identified by its script URL, so every tab has to load the broker from the
// same URL of the same origin. The library's own default - resolving the worker next to its
// entry point with `import.meta.url` - does not survive bundling, hence the explicit URL.
import workerUrl from 'serial-broker/worker?url';

/** The name every call addresses the device by. Every tab uses the same one. */
export const DEVICE_NAME = 'Dashboard';

/** The URL every tab loads the broker script from. Also what the diagnostics panel connects to. */
export const WORKER_URL: string = workerUrl;

/**
 * How the device is opened.
 *
 * `device: { any: true }` accepts whatever port the user grants, so the example runs with any
 * adapter. An application that knows its device names it by USB ids instead, which pre-filters
 * the browser's port picker and tells two granted ports apart:
 *
 * ```ts
 * device: { vendorId: 0x1a86, productId: 0x7523 } // a CH340 adapter
 * ```
 *
 * `persist` is left out on purpose: the page decides it, from the "remember" checkbox.
 */
export const DEVICE_OPTIONS: Omit<SerialBrokerOptions, 'persist'> = {
  device: { any: true },
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
};

/**
 * Applies the library-wide settings. Has to run before the first `setup()` or `restore()`: the
 * library reads them when it builds its internals, which the first of those calls does.
 */
export function configureLibrary(logger: Logger): void {
  SerialBroker.configure({ workerUrl, logger });
}

/**
 * Sets the device up on page load: from what an earlier visit remembered where there is
 * something to restore, and freshly otherwise.
 *
 * @param remember - Whether a fresh setup is persisted. A restored configuration was persisted
 *   by definition, so the value is not consulted for it.
 * @returns How the configuration came to be.
 */
export async function startDevice(remember: boolean): Promise<'restored' | 'set-up'> {
  const restored = await SerialBroker.restore();
  if (restored.includes(DEVICE_NAME)) {
    return 'restored';
  }
  await setUpDevice(remember);
  return 'set-up';
}

/**
 * Registers the configuration in this tab.
 *
 * A configuration another visit remembered with settings this version of the application no
 * longer uses would be a `CONFIGURATION_CONFLICT`. It is replaced rather than left to fail the
 * start: `persist` alone never conflicts, so this only happens after the options above change.
 */
export async function setUpDevice(remember: boolean): Promise<void> {
  const options: SerialBrokerOptions = { ...DEVICE_OPTIONS, persist: remember };
  try {
    await SerialBroker.setup(DEVICE_NAME, options);
  } catch (error) {
    if (
      error instanceof SerialBrokerError &&
      error.code === SerialBrokerErrorCode.CONFIGURATION_CONFLICT
    ) {
      await SerialBroker.release(DEVICE_NAME);
      await SerialBroker.setup(DEVICE_NAME, options);
      return;
    }
    throw error;
  }
}

/**
 * Stops using the device in this tab. Other tabs keep it, and one of them takes the port over if
 * this tab held it.
 *
 * @param forgetDevice - Also revoke the browser's permission for the port, for every tab, so the
 *   next setup asks the user again.
 */
export async function releaseDevice(forgetDevice = false): Promise<void> {
  await SerialBroker.release(DEVICE_NAME, { forgetDevice });
}

/**
 * Changes whether the configuration is remembered.
 *
 * A repeated `setup()` with only `persist` changed is a no-op - the library treats the options as
 * equivalent - so the configuration is released and set up again. The status passes through
 * `released` and comes back; other tabs are not affected.
 */
export async function setRemembered(remember: boolean): Promise<void> {
  if (SerialBroker.exists(DEVICE_NAME)) {
    await SerialBroker.release(DEVICE_NAME);
  }
  await setUpDevice(remember);
}
