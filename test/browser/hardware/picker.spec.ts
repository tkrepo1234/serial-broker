/**
 * The first connection, through Chromium's own port picker and against a real board.
 *
 * Every other suite gets its port without a prompt: the stand-in answers the picker itself, and
 * the hardware suites seed the permission into the profile. What a user meets first - the picker,
 * filtered or not, dismissed or answered - stayed by hand as steps 2 and 4a of the manual test
 * plan. Here the picker is answered through Windows UI Automation (`support/port-picker.ts`), in a
 * browser that shows a window, with a profile that has never been given the device.
 *
 * **Requires the Arduino echo board, Windows and a desktop**, so it runs only when
 * `SERIAL_BROKER_HARDWARE=picker` is set, and never in CI. See ADR-0035.
 */

import process from 'node:process';

import { chromium, expect, test as base, type BrowserContext } from '@playwright/test';

import { echoConfiguration, Tab } from '../support/tab.js';

import { recordTabHistories } from './support/hardware-context.js';
import { PortPicker } from './support/port-picker.js';

/** The device under test: an Arduino with an echo sketch. */
const ARDUINO = { vendorId: 0x2341, productId: 0x0078 } as const;
const PORT_NAME = process.env['SERIAL_BROKER_HARDWARE_PORT'] ?? 'COM3';
const CONFIGURATION = 'Picked';
/** Opening the port resets the board; what it says before this has passed is forgotten. */
const SETTLE_AFTER_OPEN_MS = 2_500;

const test = base.extend<{ fresh: { context: BrowserContext; picker: PortPicker } }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature.
  fresh: async ({}, use, testInfo) => {
    const baseURL = String(testInfo.project.use.baseURL);
    const profile = testInfo.outputPath('profile');
    // A profile that has never seen the device, and a window: the picker is browser UI, and a
    // headless browser has none to show.
    const context = await chromium.launchPersistentContext(profile, {
      ...(testInfo.project.use.channel === undefined
        ? {}
        : { channel: testInfo.project.use.channel }),
      baseURL,
      headless: false,
    });
    await use({ context, picker: new PortPicker(profile, new URL(baseURL).host) });
    if (testInfo.status !== testInfo.expectedStatus) {
      await recordTabHistories(context, testInfo, CONFIGURATION);
    }
    await context.close();
  },
});

/** Clicks the page's button, which calls `requestAccess()` with the click's activation. */
async function clickChooseDevice(tab: Tab): Promise<void> {
  await tab.page.evaluate((name) => {
    (
      window as unknown as { harness: { armAccessRequest(name: string): void } }
    ).harness.armAccessRequest(name);
  }, CONFIGURATION);
  await tab.page.click('#request-access');
}

/** How the last click ended, once the picker has been answered. */
async function accessRequestOutcome(tab: Tab): Promise<string> {
  const handle = await tab.page.waitForFunction(() =>
    (
      window as unknown as { harness: { lastAccessRequest(): string | undefined } }
    ).harness.lastAccessRequest(),
  );
  return String(await handle.jsonValue());
}

async function expectEcho(tab: Tab, line: string): Promise<void> {
  await tab.page.waitForTimeout(SETTLE_AFTER_OPEN_MS);
  await tab.clearReceived(CONFIGURATION);
  await tab.send(CONFIGURATION, line);
  await tab.waitForReceivedText(CONFIGURATION, line);
}

test.describe("Chromium's port picker, answered as a user answers it", () => {
  // One port, one board: these tests cannot overlap.
  test.describe.configure({ mode: 'serial' });
  test.skip(
    process.env['SERIAL_BROKER_HARDWARE'] !== 'picker',
    'Needs the Arduino echo board, Windows and a desktop; set SERIAL_BROKER_HARDWARE=picker.',
  );

  test('offers only the configured device, and opens it once it is picked (steps 2-4)', async ({
    fresh: { context, picker },
  }) => {
    const tab = await Tab.open(context);
    await tab.setup(CONFIGURATION, echoConfiguration({ device: ARDUINO, remember: true }));
    await tab.waitForStatus(CONFIGURATION, 'awaiting-permission');

    await clickChooseDevice(tab);
    // Filtered to the configured device: whatever else is attached to this machine is not offered.
    const offered = await picker.offeredPorts();
    expect(offered).toHaveLength(1);
    expect(offered[0]).toContain(PORT_NAME);
    await picker.pick(PORT_NAME);

    expect(await accessRequestOutcome(tab)).toBe('granted');
    await tab.waitForStatus(CONFIGURATION, 'open');
    await expectEcho(tab, 'HELLO');

    // Step 4: the browser remembers the permission and the library the configuration, so a
    // reload reconnects with no prompt.
    await tab.reload();
    expect(await tab.restore()).toEqual([CONFIGURATION]);
    await tab.waitForStatus(CONFIGURATION, 'open');
    expect(await picker.isOpen()).toBe(false);
    await expectEcho(tab, 'AGAIN');
    expect(tab.pageErrors).toEqual([]);
  });

  test('takes the device from the port picked, after a picker dismissed once (step 4a)', async ({
    fresh: { context, picker },
  }) => {
    const tab = await Tab.open(context);
    // Auto mode: no device named, so the picker is unfiltered and the port decides (ADR-0036).
    const { device: _none, ...automatic } = echoConfiguration();
    await tab.setup(CONFIGURATION, automatic);
    await tab.waitForStatus(CONFIGURATION, 'awaiting-permission');

    await clickChooseDevice(tab);
    expect((await picker.offeredPorts()).some((name) => name.includes(PORT_NAME))).toBe(true);
    await picker.cancel();
    // Dismissing is an answer, not a failure: nothing is set up, and no error is shown.
    expect(await accessRequestOutcome(tab)).toBe('dismissed');
    expect(await tab.errorCodes()).toEqual([]);
    await tab.waitForStatus(CONFIGURATION, 'awaiting-permission');

    await clickChooseDevice(tab);
    await picker.pick(PORT_NAME);
    expect(await accessRequestOutcome(tab)).toBe('granted');
    // Without a second prompt: the one answer gave the permission and the identity.
    await tab.waitForStatus(CONFIGURATION, 'open');
    expect(await picker.isOpen()).toBe(false);
    await expectEcho(tab, 'HELLO');
    expect(await tab.errorCodes()).toEqual([]);
    expect(tab.pageErrors).toEqual([]);
  });
});
