/**
 * The smoke test of this example, run through the root: `npm run test:examples --
 * examples/multi-tab-dashboard/smoke.spec.ts`. The root starts the application with its `start`
 * command on the port in `example.json`; this file drives it in the real browser with the Web
 * Serial stand-in in place of a device. See examples/README.md.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { GRANTED_DEVICE, installStandIn } from '../../test/browser/support/tab.js';

const manifest = JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8')) as {
  port: number;
};
const origin = `http://localhost:${String(manifest.port)}`;

/** What the page wrote to the console at warn or error, and what it threw. Either fails a test. */
function watchForNoise(page: Page): { readonly noise: readonly string[] } {
  const noise: string[] = [];
  page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      noise.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      noise.push(`${String(response.status())} ${response.url()}`);
    }
  });
  return { noise };
}

test.describe('the multi-tab dashboard', () => {
  test('connects to the granted device, sends a line and sees it echoed', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const page = await context.newPage();
    const { noise } = watchForNoise(page);

    await page.goto(`${origin}/`);
    // The device was granted on an "earlier visit", so no click is needed: the status goes to
    // open on its own, and the connect button - shown only while permission is missing - stays
    // hidden.
    await expect(page.locator('#status')).toHaveAttribute('data-status', 'open');
    await expect(page.locator('#status')).toHaveText('Connected');
    await expect(page.locator('#connect')).toBeHidden();
    await expect(page.locator('#error-strip')).toBeHidden();

    await page.fill('#send-input', 'PING');
    await page.click('#send-button');
    // The loopback echoes the line; it is listed as received, and the write itself as sent here.
    await expect(page.locator('#received li[data-kind="received"]')).toContainText('PING');
    await expect(page.locator('#received li[data-kind="sent-here"]')).toContainText('PING\\r\\n');

    // The diagnostics panel has collected by now, and this tab holds the port.
    await expect(page.locator('#diagnostics tbody tr[data-role="owner"]')).toHaveCount(1);
    expect(noise).toEqual([]);
  });

  test('shows a second tab the same status, and each tab sees the other', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const first = await context.newPage();
    const second = await context.newPage();
    const firstNoise = watchForNoise(first);
    const secondNoise = watchForNoise(second);

    await first.goto(`${origin}/`);
    await expect(first.locator('#status')).toHaveAttribute('data-status', 'open');
    await second.goto(`${origin}/`);
    await expect(second.locator('#status')).toHaveAttribute('data-status', 'open');

    // Each tab lists the other with the status it reports.
    const firstLabel = await first.locator('#tab-label').innerText();
    const secondLabel = await second.locator('#tab-label').innerText();
    expect(firstLabel).not.toBe(secondLabel);
    await expect(first.locator('#peers li[data-status="open"]')).toContainText(secondLabel);
    await expect(second.locator('#peers li[data-status="open"]')).toContainText(firstLabel);

    // A line sent from the second tab is echoed to both, and the first tab sees who sent it.
    await second.fill('#send-input', 'FROM-SECOND');
    await second.click('#send-button');
    await expect(first.locator('#received li[data-kind="received"]')).toContainText('FROM-SECOND');
    await expect(first.locator('#received li[data-kind="sent-elsewhere"]')).toContainText(
      'FROM-SECOND',
    );
    await expect(second.locator('#received li[data-kind="sent-here"]')).toContainText(
      'FROM-SECOND',
    );
    expect(firstNoise.noise).toEqual([]);
    expect(secondNoise.noise).toEqual([]);
  });

  test('releases in one tab only, and sets up again', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const page = await context.newPage();
    const { noise } = watchForNoise(page);

    await page.goto(`${origin}/`);
    await expect(page.locator('#status')).toHaveAttribute('data-status', 'open');

    await page.click('#release');
    await expect(page.locator('#status')).toHaveAttribute('data-status', 'released');
    await expect(page.locator('#setup-again')).toBeVisible();
    await expect(page.locator('#send-button')).toBeDisabled();

    await page.click('#setup-again');
    await expect(page.locator('#status')).toHaveAttribute('data-status', 'open');
    await expect(page.locator('#setup-again')).toBeHidden();
    expect(noise).toEqual([]);
  });
});
