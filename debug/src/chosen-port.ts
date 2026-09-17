import type { ReleaseOptions } from '../../src/core/types.js';

import { DEFAULT_NAME, defaultFormValues, type SetupFormValues } from './setup-form.js';

/**
 * What _Choose a device…_ sets up: a configuration in auto mode, ready for the browser's picker.
 *
 * This is the first thing someone trying serial-broker does, and it must work without knowing a
 * vendor ID, a product ID or a device type (ADR-0019). The library takes the device from the port
 * chosen in the picker and remembers it (ADR-0036), so nothing about the port is derived here:
 * only the name and the line settings are asked for, and the picker is opened by
 * `requestAccess()` in the click that submits them. Pure, so it is unit-tested rather than clicked
 * through with a device on the desk.
 */

/**
 * A name for the new configuration that no configuration on this origin uses yet.
 *
 * The name addresses the configuration everywhere, so two devices must not end up sharing one.
 * A name already in use is numbered.
 *
 * @param taken - The names already known on this origin, running or only remembered.
 */
export function suggestDeviceName(taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(DEFAULT_NAME)) {
    return DEFAULT_NAME;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${DEFAULT_NAME} ${String(suffix)}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * The setup form for a device to be chosen in the picker: auto mode, a suggested name, and the
 * line settings at their defaults, with 9600 baud to change.
 *
 * Nothing here is validated - the library has the verdict, as everywhere else in this page - and
 * nothing is fixed: every value can still be changed before the configuration is created.
 *
 * @param taken - The configuration names already known on this origin.
 */
export function formValuesForChosenDevice(taken: Iterable<string>): SetupFormValues {
  return {
    ...defaultFormValues(),
    name: suggestDeviceName(taken),
    deviceKind: 'auto',
    resolved: '',
    vendorId: '',
    productId: '',
  };
}

/** What {@link chooseDeviceOrUndo} needs of the library's client. */
export interface DeviceChooser {
  requestAccess(name: string): Promise<boolean>;
  release(name: string, options?: ReleaseOptions): Promise<void>;
}

/**
 * Opens the browser's port picker for a configuration just set up in auto mode, and takes the
 * configuration back when no port comes of it.
 *
 * A dismissed picker is an answer, not a failure: the configuration is released again, so nothing
 * waits for a device nobody chose. It is released with `forget`, because `setup()` remembers a
 * configuration at once and a plain release keeps what is remembered (ADR-0033): without it the
 * name would stay in the list as remembered, and the next attempt would be offered "Device 2".
 *
 * @returns Whether a port was chosen.
 * @throws What `requestAccess()` threw, after the configuration has been taken back.
 */
export async function chooseDeviceOrUndo(page: DeviceChooser, name: string): Promise<boolean> {
  let isGranted: boolean;
  try {
    isGranted = await page.requestAccess(name);
  } catch (error) {
    try {
      await page.release(name, { forget: true });
    } catch {
      // The failure of the picker is what the caller has to hear about; a release that fails on
      // top of it would only replace that error with a less useful one.
    }
    throw error;
  }
  if (!isGranted) {
    await page.release(name, { forget: true });
  }
  return isGranted;
}
