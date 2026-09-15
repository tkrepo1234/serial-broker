/**
 * What every hardware scenario needs: a browser that may use one real serial port, and a way to
 * tell which tab holds it.
 *
 * Shared by the device-specific specs, which differ in the device and in what they can make it
 * do, not in how the browser gets the port. See ADR-0035.
 */

import { chromium, expect, type BrowserContext, type TestInfo } from '@playwright/test';

import type { Tab } from '../../support/tab.js';

import { createProfileWithSerialPermission } from './seeded-profile.js';
import { findWindowsSerialDevices } from './windows-serial-device.js';

/** A USB device, by the IDs a configuration filters on. */
export interface UsbDevice {
  readonly vendorId: number;
  readonly productId: number;
}

/**
 * Starts a browser of its own whose profile already has permission for the device's COM port.
 *
 * @param portName - Which port to take when several match, such as `COM3`; the first otherwise.
 * @returns A context whose pages open the test origin. Closing it frees the port.
 */
export async function launchWithSerialPermission(
  testInfo: TestInfo,
  device: UsbDevice,
  portName?: string,
): Promise<BrowserContext> {
  const ports = findWindowsSerialDevices(device.vendorId, device.productId);
  const port = ports.find((it) => it.portName === portName) ?? ports[0];
  if (port === undefined) {
    throw new Error(
      `No serial port with USB ${hex(device.vendorId)}/${hex(device.productId)} is attached, or ` +
        'this is not Windows, where the permission is seeded by device instance ID. Check the ' +
        'Device Manager.',
    );
  }

  const baseURL = String(testInfo.project.use.baseURL);
  const profile = await createProfileWithSerialPermission(testInfo.outputPath('profile'), {
    origin: new URL(baseURL).origin,
    deviceInstanceId: port.deviceInstanceId,
    name: port.name,
  });

  // A context of its own, with a profile of its own: the permission is in that profile, and
  // the browser started for the rest of the suite has none.
  return await chromium.launchPersistentContext(profile, {
    ...(testInfo.project.use.channel === undefined
      ? {}
      : { channel: testInfo.project.use.channel }),
    baseURL,
  });
}

/**
 * Waits until exactly one of these tabs holds the port, and says which.
 *
 * A handover is not instantaneous - the successor has to open a real COM port - so this polls
 * rather than asserting once.
 */
export async function holderOf(
  tabs: readonly Tab[],
  configuration: string,
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const holders: number[] = [];
    for (const [index, tab] of tabs.entries()) {
      if (await tab.holdsOwnerLock(configuration)) {
        holders.push(index);
      }
    }
    if (holders.length === 1) {
      return holders[0] as number;
    }
    if (Date.now() >= deadline) {
      expect(holders, 'exactly one tab holds the port').toHaveLength(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** How often `needle` occurs in `haystack`. */
export function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}
