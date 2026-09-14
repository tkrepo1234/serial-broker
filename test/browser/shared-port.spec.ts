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
  Tab,
  waitForPortHolder,
} from './support/tab.js';

test.describe('a port shared across tabs', () => {
  test('is opened once for three tabs, and every tab sees the traffic', async ({ context }) => {
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

  test('delivers a payload larger than the write chunk complete and in order', async ({
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const tab = await Tab.open(context);

    await tab.setup('Echo', echoConfiguration({ encoding: { decodeText: false } }));
    await tab.waitForStatus('Echo', 'open');
    await tab.sendPattern('Echo', 40_000);
    await tab.waitForReceivedBytes('Echo', 40_000);

    // The library chunks at 4 KiB and the stand-in answers in 255-byte reads, so this crosses
    // both boundaries in both directions.
    expect(await tab.receivedPatternLength('Echo')).toBe(40_000);
  });
});
