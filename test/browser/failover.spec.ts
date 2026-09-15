/**
 * Failover, on the real platform: the tab holding the port goes away and another takes it.
 *
 * This is the decisive behaviour of the library and the one that depends most on the browser
 * rather than on the code - the Web Lock has to be released by the browser itself, with nothing
 * of ours running. Both ways of losing a tab are covered: a graceful close, and a renderer that
 * is killed with no unload handler (ADR-0005).
 *
 * Losing the broker is the other half, and it gets a scenario of its own. It is not staged with a
 * crash: Chromium is free to host a `SharedWorker` in the renderer of one of its clients or in a
 * process of its own, so a killed renderer takes the worker with it only sometimes, and a test
 * built on that would fail two minutes later for a reason that is not the library's. The worker
 * is therefore terminated outright, as step 29 of the manual test plan does from
 * `chrome://inspect/#workers`; what the tabs then do is ADR-0021. See ADR-0035.
 */

import { expect, test, type BrowserContext } from '@playwright/test';

import {
  echoConfiguration,
  GRANTED_DEVICE,
  installStandIn,
  sharedWorkersOf,
  Tab,
  tabHoldingThePort,
  terminateSharedWorkers,
  waitForPortHolder,
} from './support/tab.js';

/** Opens `count` tabs on one configuration and waits until all of them are connected. */
async function openConnectedTabs(context: BrowserContext, count: number): Promise<[Tab, ...Tab[]]> {
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
  const [first, ...rest] = tabs;
  if (first === undefined) {
    throw new Error('A scenario needs at least one tab.');
  }
  return [first, ...rest];
}

test.describe('the tab holding the port goes away', () => {
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
});

test.describe('the broker dies', () => {
  test('the tabs notice, get a new one, and go on sharing the port', async ({ context }) => {
    // Three unanswered heartbeats, 15 seconds apart, is how a dead worker is recognised
    // (ADR-0021), so this one is slow by design.
    test.setTimeout(180_000);
    await installStandIn(context, GRANTED_DEVICE);
    const tabs = await openConnectedTabs(context, 3);
    const holder = await tabHoldingThePort(tabs);
    const sender = tabs[(holder + 1) % tabs.length];
    const [worker] = await terminateSharedWorkers(tabs[0]);

    for (const tab of tabs) {
      await tab.waitForLogEvent('transport.broker-restored', 150_000);
    }

    // The bus is back, carried by a worker that is not the one that died, so a tab that does not
    // hold the port can write again and the others hear it - with the loss reported once in
    // every tab, and nothing to do about it in the application.
    await sender?.send('Echo', 'AFTER-NEW-BROKER');
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', 'AFTER-NEW-BROKER');
      expect(
        (await tab.errorCodes()).filter((code) => code === 'BROKER_UNAVAILABLE'),
        'every tab reports the loss exactly once',
      ).toEqual(['BROKER_UNAVAILABLE']);
    }
    const workersNow = await sharedWorkersOf(tabs[0]);
    expect(workersNow).toHaveLength(1);
    expect(workersNow[0]?.targetId).not.toBe(worker?.targetId);
  });
});
