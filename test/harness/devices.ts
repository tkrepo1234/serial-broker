import type { SerialBrokerOptions } from '../../src/core/types.js';

import { BrowserHarness, type HarnessOptions, type VirtualTab } from './browser-harness.js';
import type { FakeDevice } from './fake-serial.js';

/**
 * The USB IDs of a CH340 USB-serial adapter (QinHeng Electronics, `0x1a86:0x7523`).
 *
 * One of the most common adapters in the field, and all most tests need: some USB device, where
 * what the test exercises does not depend on which. A test that is about the IDs themselves -
 * filters, matching, validation - spells its values out instead, so the assertion reads on its
 * own.
 */
export const READER = { vendorId: 0x1a86, productId: 0x7523 };

/**
 * Setup options for {@link READER} at a common baud rate, for tests where neither matters.
 *
 * Every chunk is delivered as it is read (`receive.idleMs: 0`): most tests are about something
 * other than how received bytes are collected, and assert right after the device sent them. The
 * collecting itself is pinned in `test/unit/receive-buffer.test.ts` and `test/integration/receiving.test.ts`.
 */
export const READER_OPTIONS = {
  device: READER,
  serial: { baudRate: 9600 },
  receive: { idleMs: 0 },
};

/** A simulated browser in which {@link READER} is plugged in and the user has granted it. */
export function readerHarness(options: HarnessOptions = {}): {
  harness: BrowserHarness;
  device: FakeDevice;
} {
  const harness = new BrowserHarness(options);
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  return { harness, device };
}

/**
 * {@link readerHarness} with `count` tabs that have each set `Reader` up, one after the other, and
 * settled: the first tab holds the port. A scene that differs in any of this - a tab that must not
 * settle, a busy tab, a fault staged before the first open - stays in its own test file.
 *
 * `options` is merged onto {@link READER_OPTIONS}, so a test names only what it is about.
 */
export async function connectedTabs(
  count: number,
  harnessOptions: HarnessOptions = {},
  options: Partial<SerialBrokerOptions> = {},
): Promise<{ harness: BrowserHarness; device: FakeDevice; tabs: VirtualTab[] }> {
  const { harness, device } = readerHarness(harnessOptions);
  const tabs: VirtualTab[] = [];
  for (let index = 0; index < count; index += 1) {
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, ...options });
    tabs.push(tab);
  }
  return { harness, device, tabs };
}

/** {@link connectedTabs} for two tabs: `owner` holds the port, `other` shares it. */
export async function twoTabs(
  harnessOptions: HarnessOptions = {},
  options: Partial<SerialBrokerOptions> = {},
): Promise<{ harness: BrowserHarness; device: FakeDevice; owner: VirtualTab; other: VirtualTab }> {
  const { harness, device, tabs } = await connectedTabs(2, harnessOptions, options);
  return { harness, device, owner: tabs[0] as VirtualTab, other: tabs[1] as VirtualTab };
}

/** {@link connectedTabs} for the common case of one tab. */
export async function connectedTab(
  harnessOptions: HarnessOptions = {},
  options: Partial<SerialBrokerOptions> = {},
): Promise<{ harness: BrowserHarness; device: FakeDevice; tab: VirtualTab }> {
  const { harness, device, tabs } = await connectedTabs(1, harnessOptions, options);
  return { harness, device, tab: tabs[0] as VirtualTab };
}
