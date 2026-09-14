/**
 * Smoke test of the exclusive example, run through the repository root:
 *
 *     npm run build
 *     npm run test:examples -- examples/exclusive/smoke.spec.ts
 *
 * The root's Playwright configuration starts the example with `npm start` on the port in
 * example.json. The Web Serial stand-in (test/browser/stand-in/) replaces the device with a
 * granted loopback adapter: everything a page writes comes back on its read stream, and only one
 * page of the origin can hold it open, as in the browser.
 */

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { installWebSerialStandIn } from '../../test/browser/stand-in/web-serial-stand-in.js';

const APPLICATION_URL = 'http://localhost:8153/';

/** Uncaught errors and console warnings or errors of every page: any of them fails the test. */
const noise: string[] = [];

test.beforeEach(async ({ context }) => {
  noise.length = 0;
  // Before the first page: the stand-in must be there before the page's own scripts run.
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted: true }],
  });
});

test.afterEach(() => {
  expect(noise, 'the page wrote to the console or threw').toEqual([]);
});

async function openTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      noise.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  await page.goto(APPLICATION_URL);
  return page;
}

async function sendLine(page: Page, line: string): Promise<void> {
  await page.locator('#send-input').fill(line);
  await page.locator('#send-button').click();
  await expect(page.locator('#received')).toContainText(line);
}

test('one tab opens the granted device, sends a line and sees it echoed', async ({ context }) => {
  const tab = await openTab(context);

  // The device was granted on an "earlier visit", so no click is needed to reach `open`.
  await expect(tab.locator('#status')).toHaveText('open');
  await expect(tab.locator('#connect')).toBeHidden();
  await expect(tab.locator('#release')).toBeVisible();
  await expect(tab.locator('#error')).toBeHidden();

  await sendLine(tab, 'CUT 10');
});

test('a second tab is queued, and takes over when the first releases', async ({ context }) => {
  const first = await openTab(context);
  await expect(first.locator('#status')).toHaveText('open');

  const second = await openTab(context);
  await expect(second.locator('#status')).toHaveText('queued');
  await expect(second.locator('#status-explanation')).toContainText(
    'Another tab is using the device',
  );
  // Waiting is not an error, and it offers nothing to click but the way out.
  await expect(second.locator('#error')).toBeHidden();
  await expect(second.locator('#connect')).toBeHidden();
  await expect(second.locator('#send-button')).toBeDisabled();

  await first.locator('#release').click();
  await expect(first.locator('#status')).toHaveText('released');
  await expect(first.locator('#release')).toBeHidden();
  await expect(first.locator('#setup')).toBeVisible();

  await expect(second.locator('#status')).toHaveText('open');
  await sendLine(second, 'CUT 20');
  // The tab that released receives nothing any more.
  await expect(first.locator('#received')).not.toContainText('CUT 20');

  // Asking for the device again joins the queue behind the tab that took over.
  await first.locator('#setup').click();
  await expect(first.locator('#status')).toHaveText('queued');
});

test('a second tab takes over when the first closes', async ({ context }) => {
  const first = await openTab(context);
  await expect(first.locator('#status')).toHaveText('open');

  const second = await openTab(context);
  await expect(second.locator('#status')).toHaveText('queued');

  await first.close();

  await expect(second.locator('#status')).toHaveText('open');
  await sendLine(second, 'CUT 30');
});
