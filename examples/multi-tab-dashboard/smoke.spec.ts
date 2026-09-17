/**
 * The smoke test of this example, run through the root: `npm run test:examples --
 * examples/multi-tab-dashboard/smoke.spec.ts`. The root starts the application with its `start`
 * command on the port in `example.json`; this file drives it in the real browser with the Web
 * Serial stand-in in place of a device. See examples/README.md.
 */

import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import {
  ExampleTab,
  installLoopback,
  urlOfExample,
  USUAL_IDS,
  type ExampleManifest,
  type ExampleUi,
} from '../smoke-support.js';
import { crashRenderer } from '../../test/browser/support/crash.js';

const UI: ExampleUi = {
  ...USUAL_IDS,
  url: urlOfExample(
    JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8')) as ExampleManifest,
  ),
  statusIn: 'data-status',
  received: '#received li[data-kind="received"]',
  error: '#error-strip',
  release: '#release',
  setUpAgain: '#setup-again',
  failedRequestsAreNoise: true,
};

test.describe('the multi-tab dashboard', () => {
  test('connects to the granted device, sends a line and sees it echoed', async ({ context }) => {
    await installLoopback(context, true);
    const tab = await ExampleTab.open(context, UI);

    // The device was granted on an "earlier visit", so no click is needed: the status goes to
    // open on its own, and the connect button - shown only while permission is missing - stays
    // hidden.
    await tab.expectOpenWithoutClick();
    await expect(tab.locator('#status')).toHaveText('Connected');
    await expect(tab.locator('#error-strip')).toBeHidden();

    // The loopback echoes the line; it is listed as received, and the write itself as sent here.
    await tab.sendLine('PING');
    await expect(tab.locator('#received li[data-kind="sent-here"]')).toContainText('PING\\r\\n');

    // The diagnostics panel has collected by now, and this tab holds the port.
    await expect(tab.locator('#diagnostics tbody tr[data-role="owner"]')).toHaveCount(1);
    tab.expectQuiet();
  });

  test('shows a second tab the same status, and each tab sees the other', async ({ context }) => {
    await installLoopback(context, true);
    const first = await ExampleTab.open(context, UI);
    await first.expectStatus('open');
    const second = await ExampleTab.open(context, UI);
    await second.expectStatus('open');

    // Each tab lists the other with the status it reports.
    const firstLabel = await first.locator('#tab-label').innerText();
    const secondLabel = await second.locator('#tab-label').innerText();
    expect(firstLabel).not.toBe(secondLabel);
    await expect(first.locator('#peers li[data-status="open"]')).toContainText(secondLabel);
    await expect(second.locator('#peers li[data-status="open"]')).toContainText(firstLabel);

    // A line sent from the second tab is echoed to both, and the first tab sees who sent it.
    await second.sendLine('FROM-SECOND');
    await expect(first.locator('#received li[data-kind="received"]')).toContainText('FROM-SECOND');
    await expect(first.locator('#received li[data-kind="sent-elsewhere"]')).toContainText(
      'FROM-SECOND',
    );
    await expect(second.locator('#received li[data-kind="sent-here"]')).toContainText(
      'FROM-SECOND',
    );
    first.expectQuiet();
    second.expectQuiet();
  });

  test('releases in one tab only, and sets up again', async ({ context }) => {
    await installLoopback(context, true);
    const tab = await ExampleTab.open(context, UI);
    await tab.expectStatus('open');

    await tab.releaseAndSetUpAgain(async () => {
      await expect(tab.locator('#setup-again')).toBeVisible();
    });
    await expect(tab.locator('#setup-again')).toBeHidden();
    tab.expectQuiet();
  });

  test('opens its second tab through the link, with a label of its own', async ({ context }) => {
    await installLoopback(context, true);
    const first = await ExampleTab.open(context, UI);
    await first.expectStatus('open');

    // The link is noopener: the new tab starts with an empty sessionStorage rather than a copy
    // of this tab's, which would have carried the label along.
    const [page] = await Promise.all([
      context.waitForEvent('page'),
      first.locator('#open-tab').click(),
    ]);
    const second = ExampleTab.attach(page, UI);
    await second.expectStatus('open');
    const firstLabel = await first.locator('#tab-label').innerText();
    const secondLabel = await second.locator('#tab-label').innerText();
    expect(secondLabel).not.toBe(firstLabel);
    await expect(first.locator('#peers li')).toHaveCount(1);
    await expect(first.locator('#peers li')).toContainText(secondLabel);
    await expect(second.locator('#peers li')).toContainText(firstLabel);
    first.expectQuiet();
    second.expectQuiet();
  });

  test('tells two tabs apart that start with the same stored label', async ({ context }) => {
    await installLoopback(context, true);
    // What a duplicated tab looks like: the same sessionStorage, label included.
    await context.addInitScript(() => {
      sessionStorage.setItem('multi-tab-dashboard/tab-label', 'Tab SAME');
    });
    const first = await ExampleTab.open(context, UI);
    await first.expectStatus('open');
    const second = await ExampleTab.open(context, UI);
    await second.expectStatus('open');

    // One of them - which one, the ids decide - takes a new label; the other keeps it.
    await expect(async () => {
      const labels = [
        await first.locator('#tab-label').innerText(),
        await second.locator('#tab-label').innerText(),
      ];
      expect(labels).toContain('Tab SAME');
      expect(labels[0]).not.toBe(labels[1]);
    }).toPass();
    const secondLabel = await second.locator('#tab-label').innerText();
    await expect(first.locator('#peers li')).toHaveCount(1);
    await expect(first.locator('#peers li')).toContainText(secondLabel);
  });

  test('drops a tab that crashed from the list, and only that one', async ({ context }) => {
    await installLoopback(context, true);
    const first = await ExampleTab.open(context, UI);
    const second = await ExampleTab.open(context, UI);
    await expect(first.locator('#peers li[data-status="open"]')).toHaveCount(1);
    await expect(second.locator('#peers li[data-status="open"]')).toHaveCount(1);

    // A killed renderer runs no pagehide, so no goodbye is said: the second tab has to notice
    // on its own, from the pings that go unanswered. Three of them, five seconds apart.
    await crashRenderer(first.page);
    await expect(second.locator('#peers li[data-status]')).toHaveCount(0, { timeout: 30_000 });
    await expect(second.locator('#peers li')).toContainText('No other tab');
    // And the second tab took the port over meanwhile.
    await second.expectStatus('open');
  });

  test('keeps saying "not set up" when the device cannot be set up', async ({ context }) => {
    // No stand-in, and no Web Serial either: setup() has nothing to work with.
    await context.addInitScript(() => {
      delete (Navigator.prototype as { serial?: unknown }).serial;
    });
    const tab = await ExampleTab.open(context, UI);

    await tab.expectStatus('none');
    await expect(tab.locator('#status')).toHaveText('Not set up');
    await expect(tab.locator('#error-code')).toHaveText('WEB_SERIAL_UNAVAILABLE');
    await expect(tab.locator('#retry')).toBeVisible();
    // Nothing to release: the buttons stay disabled rather than claim "Released" afterwards.
    await expect(tab.locator('#release')).toBeDisabled();
    await expect(tab.locator('#forget-device')).toBeDisabled();
    await expect(tab.locator('#setup-again')).toBeHidden();
    tab.expectQuiet();
  });
});
