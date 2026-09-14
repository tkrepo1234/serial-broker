import { formatDevice, formatUsbId } from './format.js';
import { defaultFormValues, type SetupFormValues } from './setup-form.js';

/**
 * What a port chosen in the browser's port picker becomes: a configuration, ready to connect.
 *
 * This is the first thing someone trying serial-broker does, and it must work without knowing a
 * vendor ID, a product ID or a device type (ADR-0034). The picker is opened with no filter, and
 * everything the setup needs is derived here from what `SerialPort.getInfo()` reports. Pure, so
 * the derivation is unit-tested rather than clicked through with a device on the desk.
 */

/** What `SerialPort.getInfo()` reports about a port. */
export interface ChosenPortInfo {
  readonly usbVendorId?: number | undefined;
  readonly usbProductId?: number | undefined;
  readonly bluetoothServiceClassId?: number | string | undefined;
}

/** The device filter a configuration for the chosen port is set up with. */
export type ChosenDevice =
  { readonly vendorId: number; readonly productId: number } | { any: true };

/**
 * The device filter for a chosen port: its USB identity, or `any` when it reports none.
 *
 * Both IDs have to be there. A port that reports one of them is not a USB device the library
 * could find again - a filter needs both - so it is treated like every other port without a USB
 * identity (ADR-0016).
 */
export function deviceForPort(info: ChosenPortInfo): ChosenDevice {
  const { usbVendorId, usbProductId } = info;
  return usbVendorId === undefined || usbProductId === undefined
    ? { any: true }
    : { vendorId: usbVendorId, productId: usbProductId };
}

/** The chosen port in words: `USB device 0x1a86:7523`, `Bluetooth serial port`, `port with no USB identity`. */
export function describeChosenPort(info: ChosenPortInfo): string {
  const device = deviceForPort(info);
  if (!('any' in device)) {
    return `USB device ${formatDevice(device.vendorId, device.productId)}`;
  }
  return info.bluetoothServiceClassId === undefined
    ? 'port with no USB identity'
    : 'Bluetooth serial port';
}

/**
 * A name for the chosen port that no configuration on this origin uses yet.
 *
 * The name addresses the configuration everywhere, so two devices must not end up sharing one.
 * A USB device is named after its IDs, which is what the page shows for it anyway; anything else
 * after what it is. A name already in use is numbered.
 *
 * @param taken - The names already known on this origin, running or only remembered.
 */
export function suggestPortName(info: ChosenPortInfo, taken: Iterable<string>): string {
  const device = deviceForPort(info);
  const base = !('any' in device)
    ? `USB ${formatDevice(device.vendorId, device.productId)}`
    : info.bluetoothServiceClassId === undefined
      ? 'Serial port'
      : 'Bluetooth port';

  const used = new Set(taken);
  if (!used.has(base)) {
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${String(suffix)}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/**
 * The setup form as the chosen port fills it: its device, a suggested name, and the line settings
 * at their defaults, with 9600 baud to change.
 *
 * Nothing here is validated - the library has the verdict, as everywhere else in this page - and
 * nothing is fixed: every value can still be changed before the configuration is created.
 *
 * @param taken - The configuration names already known on this origin.
 */
export function formValuesForPort(info: ChosenPortInfo, taken: Iterable<string>): SetupFormValues {
  const device = deviceForPort(info);
  const defaults = defaultFormValues();
  return {
    ...defaults,
    name: suggestPortName(info, taken),
    ...('any' in device
      ? { deviceKind: 'any' as const, vendorId: '', productId: '' }
      : {
          deviceKind: 'usb' as const,
          vendorId: formatUsbId(device.vendorId),
          productId: formatUsbId(device.productId),
        }),
  };
}

/** `true` when a granted port satisfies the device filter derived from the chosen port. */
export function matchesChosenDevice(device: ChosenDevice, info: ChosenPortInfo): boolean {
  return (
    'any' in device ||
    (info.usbVendorId === device.vendorId && info.usbProductId === device.productId)
  );
}

/**
 * What the dialog says above a configuration for the chosen port.
 *
 * The permission was granted in the picker a moment ago, so connecting shows no second prompt.
 * Where several granted ports match the filter, the configuration opens the first of them - the
 * platform exposes no serial number, so identical devices cannot be told apart - and saying so is
 * the only honest thing this page can do about it.
 *
 * @param granted - What every port this browser allows this site to use reports.
 */
export function noteForChosenPort(
  info: ChosenPortInfo,
  granted: readonly ChosenPortInfo[],
): string {
  const device = deviceForPort(info);
  const sentences = [
    `You chose a ${describeChosenPort(info)}. This browser allows this page to use it, so connecting asks for nothing more.`,
  ];
  if ('any' in device) {
    sentences.push(
      'The configuration accepts any port this browser allows, because the port reports no identity to match it by.',
    );
  }
  const matching = granted.filter((granted) => matchesChosenDevice(device, granted)).length;
  if (matching > 1) {
    sentences.push(
      `${String(matching)} of the ports this browser allows match it, and the configuration opens the first of them, which may not be the one you chose.`,
    );
  }
  return sentences.join(' ');
}

/**
 * `true` when the picker was closed without choosing a port.
 *
 * Chromium rejects `requestPort()` with a `NotFoundError` for that, which is an answer rather
 * than a failure: nothing was set up, and nothing is wrong.
 */
export function isPickerDismissed(error: unknown): boolean {
  return error instanceof Error && error.name === 'NotFoundError';
}
