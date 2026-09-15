/**
 * The library against a real serial device.
 *
 * Everything else in this repository runs against something we wrote: a simulated browser, a
 * Web Serial stand-in, an emulated USB device. This file is the one place where real bytes leave
 * the machine through a real UART and come back, which is the only way to find out whether the
 * fakes are wrong in the same way as the code.
 *
 * **Requires hardware**, so it runs only when `SERIAL_BROKER_HARDWARE=arduino` is set, and never
 * in CI:
 *
 * - An Arduino (USB `0x2341`/`0x0078`) on a COM port, running a sketch that echoes every byte it
 *   receives, at 9600 baud with the default line settings.
 * - Nothing else using that port - not the Arduino IDE's serial monitor, not another test run.
 *
 * The browser gets the port through a profile that was given the permission before it started
 * (see `support/seeded-profile.ts`); no permission prompt is answered, and no machine-wide setting
 * or policy is touched. Results of a run belong in `docs/manual-test-plan.md`. See ADR-0035.
 */

import process from 'node:process';

import { expect, test as base, type BrowserContext } from '@playwright/test';

import { echoConfiguration, Tab } from '../support/tab.js';

import {
  holderOf,
  launchWithSerialPermission,
  occurrences,
  recordTabHistories,
} from './support/hardware-context.js';

/** The device under test: an Arduino with an echo sketch. */
const ARDUINO = { vendorId: 0x2341, productId: 0x0078 } as const;

/** Which COM port to use when several of these boards are attached. */
const PORT_NAME = process.env['SERIAL_BROKER_HARDWARE_PORT'] ?? 'COM3';

const CONFIGURATION = 'ArduinoEcho';

/**
 * How long to wait after the port opens before asserting on what arrives.
 *
 * Opening a serial port asserts DTR, which resets most Arduino boards: the sketch starts again,
 * and a bootloader may say something of its own first. A real application sees the same thing;
 * the test simply forgets what arrived before this point.
 */
const SETTLE_AFTER_OPEN_MS = 2_500;

const test = base.extend<{ hardware: BrowserContext }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature.
  hardware: async ({}, use, testInfo) => {
    const context = await launchWithSerialPermission(testInfo, ARDUINO, PORT_NAME);

    await use(context);

    // What each tab went through is the first thing to look at when a scenario fails, and it is
    // gone once the context closes.
    if (testInfo.status !== testInfo.expectedStatus) {
      await recordTabHistories(context, testInfo, CONFIGURATION);
    }

    // Every page and the browser itself go away here, which is what frees the port for the next
    // test. Nothing else on this machine may use it in between.
    await context.close();
  },
});

/** Opens `count` tabs, connects them to the device and waits until the board has settled. */
async function connectedTabs(context: BrowserContext, count: number): Promise<Tab[]> {
  const tabs: Tab[] = [];
  for (let index = 0; index < count; index += 1) {
    tabs.push(await Tab.open(context));
  }
  for (const tab of tabs) {
    await tab.setup(CONFIGURATION, echoConfiguration({ device: ARDUINO }));
  }
  for (const tab of tabs) {
    await tab.waitForStatus(CONFIGURATION, 'open');
  }
  await tabs[0]?.page.waitForTimeout(SETTLE_AFTER_OPEN_MS);
  for (const tab of tabs) {
    await tab.clearReceived(CONFIGURATION);
  }
  return tabs;
}

/** One tab, set up for bytes rather than text and with room for a long write. */
async function largePayloadTabs(context: BrowserContext): Promise<Tab[]> {
  const tab = await Tab.open(context);
  await tab.setup(
    CONFIGURATION,
    echoConfiguration({
      device: ARDUINO,
      encoding: { decodeText: false },
      // The write itself is handed to the driver quickly; this only has to outlast a full
      // transmit buffer.
      connection: { writeTimeoutMs: 120_000 },
    }),
  );
  await tab.waitForStatus(CONFIGURATION, 'open');
  await tab.page.waitForTimeout(SETTLE_AFTER_OPEN_MS);
  await tab.clearReceived(CONFIGURATION);
  return [tab];
}

/** What one tab received, as text. */
async function text(tab: Tab | undefined): Promise<string> {
  return (await tab?.receivedText(CONFIGURATION)) ?? '';
}

test.describe('an Arduino running an echo sketch', () => {
  // One port, one board: these tests cannot overlap.
  test.describe.configure({ mode: 'serial' });
  test.skip(
    process.env['SERIAL_BROKER_HARDWARE'] !== 'arduino',
    'Needs the Arduino echo sketch on a COM port; set SERIAL_BROKER_HARDWARE=arduino to run it.',
  );

  test('echoes what a single tab sends', async ({ hardware }) => {
    const [tab] = await connectedTabs(hardware, 1);

    await tab?.send(CONFIGURATION, 'HELLO');

    await tab?.waitForReceivedText(CONFIGURATION, 'HELLO');
  });

  test('delivers an echoed line as one event, not one per byte (ADR-0039)', async ({
    hardware,
  }) => {
    const [tab] = await connectedTabs(hardware, 1);

    await tab?.send(CONFIGURATION, '1234\r\n');

    // The board echoes a byte at a time, and the default quiet time joins them into one event.
    await tab?.waitForReceivedText(CONFIGURATION, '1234\r\n');
    await tab?.page.waitForTimeout(500);
    expect(await tab?.receiveEventCount(CONFIGURATION)).toBe(1);
  });

  test('echoes to both tabs sharing the port', async ({ hardware }) => {
    const tabs = await connectedTabs(hardware, 2);

    await tabs[1]?.send(CONFIGURATION, 'TWO-TABS');

    for (const tab of tabs) {
      await tab.waitForReceivedText(CONFIGURATION, 'TWO-TABS');
    }
    // The device saw the bytes once - it echoed them once - and both tabs saw that one echo.
    // Counted rather than measured in bytes: a board that is still echoing an earlier payload
    // is a slow device, not a failure of this.
    expect(occurrences(await text(tabs[0]), 'TWO-TABS')).toBe(1);
    expect(occurrences(await text(tabs[1]), 'TWO-TABS')).toBe(1);
  });

  test('echoes to all three tabs sharing the port', async ({ hardware }) => {
    const tabs = await connectedTabs(hardware, 3);

    await tabs[2]?.send(CONFIGURATION, 'THREE-TABS');

    for (const tab of tabs) {
      await tab.waitForReceivedText(CONFIGURATION, 'THREE-TABS');
    }
    expect((await tabs[2]?.sends(CONFIGURATION))?.map((send) => send.origin)).toEqual(['local']);
    expect((await tabs[0]?.sends(CONFIGURATION))?.map((send) => send.origin)).toEqual(['remote']);
  });

  test('keeps echoing when the tab holding the port closes', async ({ hardware }) => {
    const tabs = await connectedTabs(hardware, 3);
    const holder = await holderOf(tabs, CONFIGURATION);
    const survivors = tabs.filter((_, index) => index !== holder);

    await tabs[holder]?.page.close();

    // The port is reopened by another tab - a real open of a real COM port, including the
    // board's reset - and then the echo works again from a tab that never had it.
    await holderOf(survivors, CONFIGURATION);
    await survivors[0]?.page.waitForTimeout(SETTLE_AFTER_OPEN_MS);
    await survivors[0]?.send(CONFIGURATION, 'AFTER-FAILOVER');
    for (const tab of survivors) {
      await tab.waitForReceivedText(CONFIGURATION, 'AFTER-FAILOVER', 30_000);
    }
  });

  test('echoes a payload larger than the write chunk, byte for byte', async ({ hardware }) => {
    // Slower than it looks: the board this was written against echoes at about 80 bytes a second,
    // whatever the line rate, so 5 000 bytes take a good minute to come back.
    test.setTimeout(240_000);
    const [tab] = await largePayloadTabs(hardware);
    const seed = Math.floor(Math.random() * 1_000_000);

    await tab?.sendPattern(CONFIGURATION, 5_000, seed);

    // 5 000 bytes is more than one write chunk (4 096) and far more than one read, so this
    // crosses boundaries in both directions - and every byte of it is the one that was sent.
    await tab?.waitForPatternRun(CONFIGURATION, 5_000, 180_000);
  });

  test('connects again after the configuration was released', async ({ hardware }) => {
    const [tab] = await connectedTabs(hardware, 1);
    await tab?.send(CONFIGURATION, 'BEFORE-RELEASE');
    await tab?.waitForReceivedText(CONFIGURATION, 'BEFORE-RELEASE');

    await tab?.release(CONFIGURATION);
    await tab?.setup(CONFIGURATION, echoConfiguration({ device: ARDUINO }));

    // The browser kept the permission, so this needs no prompt and no user gesture.
    await tab?.waitForStatus(CONFIGURATION, 'open');
    await tab?.page.waitForTimeout(SETTLE_AFTER_OPEN_MS);
    await tab?.clearReceived(CONFIGURATION);
    await tab?.send(CONFIGURATION, 'AFTER-RELEASE');
    await tab?.waitForReceivedText(CONFIGURATION, 'AFTER-RELEASE');
  });
});
