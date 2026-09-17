/**
 * Permission and reconnection, as the browser does them.
 *
 * Both are places where the library depends on browser behaviour that a fake can only claim: that
 * a port granted from a click is usable at once, and that an unplugged device errors the read
 * stream of whoever holds it and announces itself again when it comes back (ADR-0022, ADR-0008).
 * See ADR-0021.
 */

import { expect, test } from '@playwright/test';

import { echoConfiguration, installStandIn, Tab, UNGRANTED_DEVICE } from './support/tab.js';

test.describe('a device the origin has no permission for', () => {
  test('waits at awaiting-permission and opens after the picker was used from a click', async ({
    context,
  }) => {
    await installStandIn(context, UNGRANTED_DEVICE);
    const tab = await Tab.open(context);

    await tab.setup('Echo', echoConfiguration());
    await tab.waitForStatus('Echo', 'awaiting-permission');
    const outcome = await tab.requestAccessByClick('Echo');

    expect(outcome).toBe('granted');
    await tab.waitForStatus('Echo', 'open');
    await tab.send('Echo', 'AFTER-GRANT');
    await tab.waitForReceivedText('Echo', 'AFTER-GRANT');
  });

  // There is no browser test for `USER_GESTURE_REQUIRED`: the test runner evaluates every script
  // with transient activation, so a page driven by it can never be *without* a gesture. The
  // in-process suite covers that case, and the manual test plan covers the picker itself.
});

test.describe('a device chosen in auto mode', () => {
  test('comes from the picker, is adopted by a second tab, and opens unasked on a later visit', async ({
    context,
  }) => {
    await installStandIn(context, UNGRANTED_DEVICE);
    const auto = echoConfiguration({ device: { auto: true }, remember: true });
    const first = await Tab.open(context);

    await first.setup('Auto', auto);
    await first.waitForStatus('Auto', 'awaiting-permission');
    expect(await first.requestAccessByClick('Auto')).toBe('granted');
    await first.waitForStatus('Auto', 'open');

    // A second tab in auto mode takes the device the first one chose, with no click of its own.
    const second = await Tab.open(context);
    await second.setup('Auto', auto);
    await second.waitForStatus('Auto', 'open');
    await second.send('Auto', 'FROM-SECOND');
    await first.waitForReceivedText('Auto', 'FROM-SECOND');

    // A later visit: every tab is gone, and a new one opens the remembered device without asking.
    await first.page.close();
    await second.page.close();
    const later = await Tab.open(context);
    await later.setup('Auto', auto);
    await later.waitForStatus('Auto', 'open');
    expect(await later.statuses('Auto')).not.toContain('awaiting-permission');
  });
});
