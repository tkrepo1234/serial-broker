import type { NormalizedConfiguration } from '../core/defaults.js';
import type { ScopedLogger } from '../core/logger.js';
import type { SerialLike } from '../environment/environment.js';

/**
 * Finds the port matching a configuration among those the user has already granted.
 *
 * This is what makes a released port "remembered": the browser keeps the permission, and
 * `getPorts()` returns the granted port on every later visit with no prompt. All this library
 * has to do is recognise which of them is the configured device, which it does by the only
 * identity the platform exposes - the USB vendor and product IDs. See ADR-0009.
 *
 * @returns The first granted port whose IDs match, or `undefined` if none does.
 */
export async function findGrantedPort(
  serial: SerialLike,
  configuration: NormalizedConfiguration,
  logger: ScopedLogger,
): Promise<SerialPort | undefined> {
  const ports = await serial.getPorts();
  const matches = ports.filter((port) => matchesDevice(port, configuration));

  const first = matches[0];
  if (first === undefined) {
    logger.debug('no granted port matches the configured device', {
      configName: configuration.name,
      event: 'matcher.none',
      grantedPorts: ports.length,
    });
    return undefined;
  }

  if (matches.length > 1) {
    // The platform exposes no serial number, so two identical adapters are genuinely
    // indistinguishable here. Picking the first is deterministic within a session; warning is
    // the most honest thing available. Documented as a known limitation in the README.
    logger.warn('several granted ports match the configured device; using the first', {
      configName: configuration.name,
      event: 'matcher.ambiguous',
      matchCount: matches.length,
    });
  }

  return first;
}

/** `true` if a port reports the configured USB vendor and product IDs. */
export function matchesDevice(port: SerialPort, configuration: NormalizedConfiguration): boolean {
  const info = port.getInfo();
  return (
    info.usbVendorId === configuration.device.vendorId &&
    info.usbProductId === configuration.device.productId
  );
}

/**
 * Builds the filter for the browser's port picker.
 *
 * Pre-filtering the picker to the configured device is the difference between a user choosing
 * from two entries and choosing from fifteen, half of which are internal serial devices that
 * would fail to match afterwards anyway.
 */
export function toRequestOptions(configuration: NormalizedConfiguration): SerialPortRequestOptions {
  return {
    filters: [
      {
        usbVendorId: configuration.device.vendorId,
        usbProductId: configuration.device.productId,
      },
    ],
  };
}
