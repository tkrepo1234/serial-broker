/**
 * The product claim, in a real browser: several tabs, one port, one `SharedWorker`.
 *
 * The in-process suite proves the coordination against a simulated platform. This proves that the
 * platform behaves as that simulation assumes - a real `SharedWorker` handshake, real Web Locks,
 * and the built files finding each other. See ADR-0035.
 */

import { expect, test } from '@playwright/test';

import {
  echoConfiguration,
  GRANTED_DEVICE,
  installStandIn,
  sharedWorkersOf,
  Tab,
  waitForPortHolder,
} from './support/tab.js';

test.describe('a port shared across tabs', () => {
  test('is opened once for three tabs, and every tab sees the traffic', async ({
    baseURL,
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const first = await Tab.open(context);
    const second = await Tab.open(context);
    const third = await Tab.open(context);
    const tabs = [first, second, third];

    for (const tab of tabs) {
      await tab.setup('Echo', echoConfiguration());
    }
    for (const tab of tabs) {
      await tab.waitForStatus('Echo', 'open');
    }
    await second.send('Echo', 'PING');
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', 'PING');
    }

    // Exactly one tab has the device open - the whole point - and it is the browser's own
    // SharedWorker that carried the traffic to the others: a tab that had to fall back would
    // have said so.
    await waitForPortHolder(tabs);
    expect(await second.receivedText('Echo')).toBe('PING');
    expect(await first.receivedText('Echo')).toBe('PING');
    expect(await third.receivedText('Echo')).toBe('PING');
    expect((await second.sends('Echo')).map((send) => send.origin)).toEqual(['local']);
    expect((await first.sends('Echo')).map((send) => send.origin)).toEqual(['remote']);
    expect((await third.sends('Echo')).map((send) => send.origin)).toEqual(['remote']);
    for (const tab of tabs) {
      expect(await tab.logEvents()).not.toContain('environment.transport-fallback');
      expect(tab.pageErrors).toEqual([]);
    }
    // And there is exactly one of them for the three tabs, from the built worker file - the
    // claim the whole design rests on, which only the browser can be asked about.
    const workers = await sharedWorkersOf(first);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.url).toBe(new URL('/dist/serial-broker.worker.js', baseURL).href);
  });

  test('carries on while a tab that is not holding the port is frozen', async ({ context }) => {
    // An operator's station leaves tabs open for days, and Chromium freezes one it considers
    // asleep: it then runs nothing at all - no timer, no callback, no message handler. A frozen
    // participant must not hold up the tabs still working, and must catch up when it is looked
    // at again rather than having to be reloaded. See step 7 of the manual test plan, whose
    // milder case - a tab merely in the background - is `test/browser/background-tab.mjs`.
    await installStandIn(context, GRANTED_DEVICE);
    const tabs = [await Tab.open(context), await Tab.open(context), await Tab.open(context)];
    for (const tab of tabs) {
      await tab.setup('Echo', echoConfiguration());
    }
    for (const tab of tabs) {
      await tab.waitForStatus('Echo', 'open');
    }
    const holder = tabs[await waitForPortHolder(tabs)];
    const sleeper = tabs.find((tab) => tab !== holder);
    const awake = tabs.filter((tab) => tab !== sleeper);

    await sleeper?.freeze();
    await awake[0]?.send('Echo', 'WHILE-ONE-SLEEPS');
    for (const tab of awake) {
      await tab.waitForReceivedText('Echo', 'WHILE-ONE-SLEEPS');
    }
    expect(await holder?.holdsPort(), 'the port stayed where it was').toBe(true);

    // Thawed: the line it slept through is there, and the next one arrives as it does anywhere
    // else - no reload, nothing to set up again.
    await sleeper?.resume();
    await sleeper?.waitForReceivedText('Echo', 'WHILE-ONE-SLEEPS');
    await awake[0]?.send('Echo', 'AFTER-WAKING');
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', 'AFTER-WAKING');
      expect(tab.pageErrors).toEqual([]);
    }
  });

  test('carries bytes from every tab to the device exactly once', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const first = await Tab.open(context);
    const second = await Tab.open(context);

    for (const tab of [first, second]) {
      await tab.setup('Echo', echoConfiguration());
      await tab.waitForStatus('Echo', 'open');
    }
    await first.send('Echo', 'A');
    await second.send('Echo', 'B');
    for (const tab of [first, second]) {
      await tab.waitForReceivedText('Echo', 'A');
      await tab.waitForReceivedText('Echo', 'B');
    }

    // Two writes, two echoes, in both tabs: nothing was sent twice because two tabs were
    // attached, and nothing was delivered twice because the sender also hears its own send.
    expect(await first.receivedByteCount('Echo')).toBe(2);
    expect(await second.receivedByteCount('Echo')).toBe(2);
    expect(await first.sends('Echo')).toHaveLength(2);
    expect(await second.sends('Echo')).toHaveLength(2);
  });

  test('decodes text whose characters are cut in half by a read boundary', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const first = await Tab.open(context);
    const second = await Tab.open(context);
    const tabs = [first, second];

    // `Grüße, 温度` is 15 bytes of UTF-8, and the device answers in reads of 8: 8 and 15 share
    // no factor, so the boundary walks through every offset of the phrase and `ü`, `ß`, `温`
    // and `度` are each split between two reads. A decoder that starts afresh on every read
    // answers with U+FFFD instead.
    const options = echoConfiguration({
      serial: { baudRate: 9600, bufferSize: 8 },
      receive: { idleMs: 0 },
    });
    for (const tab of tabs) {
      await tab.setup('Echo', options);
      await tab.waitForStatus('Echo', 'open');
    }
    const sent = 'Grüße, 温度'.repeat(20);

    await first.send('Echo', sent);

    // In the tab that decoded it and in the tab it was carried to: the text that was sent,
    // exactly, with nothing lost at a boundary and nothing replaced.
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', sent);
      expect(await tab.receivedText('Echo')).toBe(sent);
    }
  });
});
