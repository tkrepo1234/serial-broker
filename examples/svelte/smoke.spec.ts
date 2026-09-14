/**
 * Smoke test of the Svelte example, run through the repository root:
 *
 *     npm run build
 *     npm run test:examples -- examples/svelte/smoke.spec.ts
 *
 * The root's Playwright configuration starts the example with `npm start` on the port in
 * example.json. The Web Serial stand-in (test/browser/stand-in/) replaces the device with a
 * loopback adapter: everything a page writes comes back on its read stream.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  installWebSerialStandIn,
  type WebSerialStandInControl,
} from '../../test/browser/stand-in/web-serial-stand-in.js';

const APPLICATION_URL = 'http://localhost:8157/';

/** The stand-in's controls, as the page sees them; `page.evaluate` cannot import the type. */
interface StandInWindow {
  readonly webSerialStandIn?: WebSerialStandInControl;
}

/** Uncaught errors and console warnings or errors of every page: any of them fails the test. */
const noise: string[] = [];

test.afterEach(() => {
  expect(noise, 'a page wrote to the console or threw').toEqual([]);
});

/** Installs the stand-in before any page of the context runs its own scripts. */
async function withDevice(context: BrowserContext, granted: boolean): Promise<void> {
  noise.length = 0;
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted }],
  });
}

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
  await expect(page.locator('#send-input')).toHaveValue('');
}

test('connects on load, echoes a line, and survives the device being unplugged', async ({
  context,
}) => {
  await withDevice(context, true);
  const page = await openTab(context);

  // The device was granted on an "earlier visit", so the port opens with no click.
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#connect')).toBeHidden();
  await expect(page.locator('#send-button')).toBeEnabled();

  await sendLine(page, 'PING');
  // PING and CR LF: six bytes out, the same six back.
  await expect(page.locator('#counters')).toHaveText('6 bytes received, 6 bytes sent by any tab');
  await expect(page.locator('#error')).toBeHidden();

  // Unplugging is a failure the library recovers from by itself: a note, not a problem, next to
  // the reconnecting status - and gone once the port is open again.
  await page.evaluate(() => {
    (window as unknown as StandInWindow).webSerialStandIn?.unplug();
  });
  await expect(page.locator('#status')).toHaveText('reconnecting');
  await expect(page.locator('#error')).toHaveAttribute('data-retryable', 'true');
  await expect(page.locator('#error-code')).toHaveText('DEVICE_DISCONNECTED');
  await expect(page.locator('#error-remediation')).not.toBeEmpty();
  await expect(page.locator('#error-recovering')).toBeVisible();
  await expect(page.locator('#send-button')).toBeDisabled();

  await page.evaluate(() => {
    (window as unknown as StandInWindow).webSerialStandIn?.plug();
  });
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#error')).toBeHidden();
  await sendLine(page, 'AGAIN');
});

test('asks for the device with the connect button, and only then', async ({ context }) => {
  await withDevice(context, false);
  const page = await openTab(context);

  await expect(page.locator('#status')).toHaveText('awaiting-permission');
  await expect(page.locator('#send-button')).toBeDisabled();
  await expect(page.locator('#error')).toBeHidden();

  // A real click: requestPort() - the stand-in's as much as the browser's - needs the gesture.
  await page.locator('#connect').click();
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#connect')).toBeHidden();
  await sendLine(page, 'HELLO');
});

test('releases in one tab while the other keeps the device, and sets up again', async ({
  context,
}) => {
  await withDevice(context, true);
  const first = await openTab(context);
  await expect(first.locator('#status')).toHaveText('open');
  const second = await openTab(context);
  await expect(second.locator('#status')).toHaveText('open');

  // Both tabs receive what either sends, whichever holds the port.
  await sendLine(first, 'FROM FIRST');
  await expect(second.locator('#received')).toContainText('FROM FIRST');

  await first.locator('#release').click();
  await expect(first.locator('#status')).toHaveText('released');
  await expect(first.locator('#release')).toBeHidden();
  await expect(first.locator('#restart')).toBeVisible();
  await expect(first.locator('#send-button')).toBeDisabled();

  // The other tab keeps the device, and takes the port over if the first held it.
  await expect(second.locator('#status')).toHaveText('open');
  await sendLine(second, 'FROM SECOND');
  await expect(first.locator('#received')).not.toContainText('FROM SECOND');

  await first.locator('#restart').click();
  await expect(first.locator('#status')).toHaveText('open');
  await expect(first.locator('#restart')).toBeHidden();
  await sendLine(first, 'BACK');
  await expect(second.locator('#received')).toContainText('BACK');
});
