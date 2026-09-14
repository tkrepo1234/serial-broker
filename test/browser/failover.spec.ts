/**
 * Failover, on the real platform: the tab holding the port goes away and another takes it.
 *
 * This is the decisive behaviour of the library and the one that depends most on the browser
 * rather than on the code - the Web Lock has to be released by the browser itself, with nothing
 * of ours running. Both ways of losing a tab are covered: a graceful close, and a renderer that
 * is killed with no unload handler (ADR-0005).
 *
 * The killed renderer costs the tabs their broker as well: Chromium may host a `SharedWorker` in
 * the renderer process of one of its clients, so killing that process kills the worker too. That
 * is the case ADR-0021 is about, and the last test here is the one that shows the tabs coming
 * back from it unaided. See ADR-0035.
 */

import { expect, test, type BrowserContext } from '@playwright/test';

import {
  echoConfiguration,
  GRANTED_DEVICE,
  installStandIn,
  Tab,
  tabHoldingThePort,
  waitForPortHolder,
} from './support/tab.js';

/** Opens `count` tabs on one configuration and waits until all of them are connected. */
async function openConnectedTabs(context: BrowserContext, count: number): Promise<Tab[]> {
  const tabs: Tab[] = [];
  for (let index = 0; index < count; index += 1) {
    tabs.push(await Tab.open(context));
  }
  for (const tab of tabs) {
    await tab.setup('Echo', echoConfiguration());
  }
  for (const tab of tabs) {
    await tab.waitForStatus('Echo', 'open');
  }
  return tabs;
}

test.describe('the tab holding the port goes away', () => {
  test('another tab takes the port over when it closes', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const tabs = await openConnectedTabs(context, 3);
    const holder = await tabHoldingThePort(tabs);
    const survivors = tabs.filter((_, index) => index !== holder);

    await tabs[holder]?.page.close();

    // One of the others now has the device, and the shared port still works from a tab that
    // never had it.
    await waitForPortHolder(survivors);
    await survivors[0]?.send('Echo', 'AFTER-CLOSE');
    for (const tab of survivors) {
      await tab.waitForReceivedText('Echo', 'AFTER-CLOSE');
    }
  });

  test('another tab takes the port over when its renderer is killed', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const tabs = await openConnectedTabs(context, 3);
    const holder = await tabHoldingThePort(tabs);
    const survivors = tabs.filter((_, index) => index !== holder);

    // No unload handler runs, and nothing releases the lock or closes the port: the browser
    // does both because the context ceased to exist.
    await tabs[holder]?.crash();

    const owner = survivors[await waitForPortHolder(survivors)];
    await owner?.send('Echo', 'AFTER-CRASH');
    await owner?.waitForReceivedText('Echo', 'AFTER-CRASH');
  });

  test('the tabs find a new broker when the crash took the worker with it', async ({ context }) => {
    // Three unanswered heartbeats, 15 seconds apart, is how a dead worker is recognised
    // (ADR-0021), so this one is slow by design.
    test.setTimeout(180_000);
    await installStandIn(context, GRANTED_DEVICE);
    const tabs = await openConnectedTabs(context, 3);
    const holder = await tabHoldingThePort(tabs);
    const survivors = tabs.filter((_, index) => index !== holder);
    const sender = survivors[1];

    await tabs[holder]?.crash();
    await sender?.waitForLogEvent('transport.broker-restored', 150_000);

    // The bus is back, so a tab that does not hold the port can write again and the other tab
    // hears it - with the loss reported once, and nothing to do about it in the application.
    await sender?.send('Echo', 'AFTER-NEW-BROKER');
    for (const tab of survivors) {
      await tab.waitForReceivedText('Echo', 'AFTER-NEW-BROKER');
    }
    expect((await sender?.errorCodes())?.filter((code) => code === 'BROKER_UNAVAILABLE')).toEqual([
      'BROKER_UNAVAILABLE',
    ]);
  });
});
