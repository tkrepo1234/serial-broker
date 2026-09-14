import {
  effectiveDevice,
  type NormalizedConfiguration,
  type NormalizedDeviceFilter,
  type ResolvedDevice,
} from '../core/defaults.js';
import type { ScopedLogger } from '../core/logger.js';
import type {
  SerialLike,
  SerialPortInfoLike,
  SerialPortLike,
  SerialPortRequestOptionsLike,
} from '../environment/environment.js';

/** The part of a configuration that decides which port is the configured device. */
export type DeviceSelection = Pick<NormalizedConfiguration, 'device'>;

/**
 * Finds the port matching a configuration among those the user has already granted.
 *
 * This is what makes a released port "remembered": the browser keeps the permission, and
 * `getPorts()` returns the granted port on every later visit with no prompt. All this library
 * has to do is recognise which of them is the configured device. See ADR-0009.
 *
 * @returns The first granted port that matches, or `undefined` if none does - always `undefined`
 *   for an auto-mode configuration that has not resolved, however many ports are granted
 *   (ADR-0036).
 */
export async function findGrantedPort(
  serial: SerialLike,
  configuration: Pick<NormalizedConfiguration, 'name' | 'device'>,
  logger: ScopedLogger,
): Promise<SerialPortLike | undefined> {
  const ports = await serial.getPorts();
  const matches = ports.filter((port) => matchesDevice(port, configuration));

  const first = matches[0];
  if (first === undefined) {
    logger.debug('no granted port matches the configured device', {
      configName: configuration.name,
      event: 'matcher.none',
      grantedPorts: ports.length,
      filter: configuration.device.kind,
    });
    return undefined;
  }

  if (matches.length > 1) {
    // The platform exposes no serial number, so identical devices are genuinely
    // indistinguishable here - and an `any` filter cannot distinguish anything at all.
    // Picking the first is deterministic within a session; warning is the most honest thing
    // available. Documented as a known limitation in the README.
    logger.warn('several granted ports match the configuration; using the first', {
      configName: configuration.name,
      event: 'matcher.ambiguous',
      matchCount: matches.length,
      filter: effectiveDevice(configuration.device)?.kind ?? configuration.device.kind,
    });
  }

  return first;
}

/**
 * `true` if a port satisfies a configuration's device filter.
 *
 * An `any` filter matches every granted port, including ports that report no identifying
 * information at all - a built-in RS-232 interface, a virtual COM port pair, a Bluetooth
 * serial profile (ADR-0016). A non-USB filter matches exactly those. An auto-mode filter matches
 * what it has resolved to, and nothing before it has: the user's choice is the resolution, and a
 * port granted for something else is not it (ADR-0036).
 */
export function matchesDevice(port: SerialPortLike, configuration: DeviceSelection): boolean {
  const device = effectiveDevice(configuration.device);
  if (device === undefined) {
    return false;
  }
  if (device.kind === 'any') {
    return true;
  }

  const info = port.getInfo();
  if (device.kind === 'non-usb') {
    return !hasUsbIdentity(info);
  }
  return info.usbVendorId === device.vendorId && info.usbProductId === device.productId;
}

/**
 * The device a chosen port is, as auto mode resolves it (ADR-0036).
 *
 * A USB identity needs both IDs. A port that reports one of them is not a USB device a filter
 * could find again, so it counts as a port without one, as ADR-0034 decided for the debugging
 * surface.
 */
export function resolveDevice(port: SerialPortLike): ResolvedDevice {
  const info = port.getInfo();
  return hasUsbIdentity(info)
    ? { kind: 'usb', vendorId: info.usbVendorId, productId: info.usbProductId }
    : { kind: 'non-usb' };
}

/** `true` if a port reports both USB IDs, which is what a USB filter can match. */
function hasUsbIdentity(
  info: SerialPortInfoLike,
): info is { readonly usbVendorId: number; readonly usbProductId: number } {
  return typeof info.usbVendorId === 'number' && typeof info.usbProductId === 'number';
}

/**
 * Builds the filter for the browser's port picker.
 *
 * Pre-filtering the picker to the configured device is the difference between a user choosing
 * from two entries and choosing from fifteen, half of which are internal serial devices that
 * would fail to match afterwards anyway.
 *
 * Every filter but a USB one passes no `filters` at all: a non-USB port cannot be described by
 * one - and passing an empty array would hide exactly the ports it is meant to find - and an
 * auto-mode configuration that has not resolved is asking which port the user means.
 */
export function toRequestOptions(configuration: DeviceSelection): SerialPortRequestOptionsLike {
  const device = effectiveDevice(configuration.device);
  if (device?.kind !== 'usb') {
    return {};
  }

  return {
    filters: [{ usbVendorId: device.vendorId, usbProductId: device.productId }],
  };
}

/** The filter as `getStatus()` and a `status` message describe it: what is in effect, by kind. */
export function describeDevice(filter: NormalizedDeviceFilter): {
  readonly kind: 'usb' | 'non-usb' | 'any' | 'auto';
  readonly vendorId: number | undefined;
  readonly productId: number | undefined;
} {
  const device = effectiveDevice(filter);
  if (device === undefined) {
    return { kind: 'auto', vendorId: undefined, productId: undefined };
  }
  return {
    kind: device.kind,
    vendorId: device.kind === 'usb' ? device.vendorId : undefined,
    productId: device.kind === 'usb' ? device.productId : undefined,
  };
}
