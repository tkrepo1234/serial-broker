/**
 * What every hardware scenario needs: a browser that may use one real serial port, and a way to
 * tell which tab holds it.
 *
 * Shared by the device-specific specs, which differ in the device and in what they can make it
 * do, not in how the browser gets the port. See ADR-0035.
 */

import { writeFile } from 'node:fs/promises';
import process from 'node:process';

import { chromium, expect, type BrowserContext, type TestInfo } from '@playwright/test';

import type { Tab } from '../../support/tab.js';

import { createProfileWithSerialPermission } from './seeded-profile.js';
import { findWindowsSerialDevices } from './windows-serial-device.js';

/** The board the Arduino and picker suites run against: an Arduino with an echo sketch. */
export const ARDUINO = { vendorId: 0x2341, productId: 0x0078 } as const;

/** Which COM port to use when several of these boards are attached. */
export const ARDUINO_PORT_NAME = process.env['SERIAL_BROKER_HARDWARE_PORT'] ?? 'COM3';

/**
 * How long to wait after the port opens before asserting on what arrives.
 *
 * Opening a serial port asserts DTR, which resets most Arduino boards: the sketch starts again,
 * and a bootloader may say something of its own first. A real application sees the same thing;
 * the test simply forgets what arrived before this point.
 */
export const SETTLE_AFTER_OPEN_MS = 2_500;

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

/**
 * Writes what each tab of a failed test went through - its statuses, the error codes it was told
 * and the library's log - next to the test's results.
 *
 * Called before the context closes, which takes the tabs' side with it. As files, because a
 * reporter shortens what it prints, and a long history is the point.
 */
export async function recordTabHistories(
  context: BrowserContext,
  testInfo: TestInfo,
  configuration: string,
): Promise<void> {
  for (const [index, page] of context.pages().entries()) {
    // A persistent context starts with a blank page of its own, which never loads the harness.
    if (page.url() === 'about:blank') {
      continue;
    }
    const history = await page
      .evaluate((name) => {
        const { harness } = window as unknown as {
          harness?: {
            statuses(name: string): readonly string[];
            errorCodes(): readonly string[];
            logRecords(): unknown;
          };
        };
        return {
          statuses: harness?.statuses(name),
          errors: harness?.errorCodes(),
          log: harness?.logRecords(),
        };
      }, configuration)
      .catch((error: unknown) => String(error));
    await writeFile(
      testInfo.outputPath(`tab-${String(index)}.json`),
      JSON.stringify(history, undefined, 2),
    );
  }
}

/** How often `needle` occurs in `haystack`. */
export function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}
