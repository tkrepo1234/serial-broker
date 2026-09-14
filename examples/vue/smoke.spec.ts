/**
 * Smoke test of the Vue example, run through the repository root:
 *
 *     npm run build            # once, at the repository root
 *     npm run test:examples -- examples/vue/smoke.spec.ts
 *
 * The root configuration starts the example with its `npm start` on the port in example.json. The
 * Web Serial stand-in (test/browser/stand-in/) replaces the device with a loopback adapter:
 * everything a page writes comes back on its read stream.
 *
 * Two tests, because the composable has two ways to an open port: a device the origin was granted
 * on an earlier visit opens on load with no click, and one that was not needs the Connect click.
 * Every page error, console error and console warning fails the test.
 */
import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import {
  installWebSerialStandIn,
  type WebSerialStandInControl,
} from '../../test/browser/stand-in/web-serial-stand-in.js';

/** The manifest the root reads, so the port lives in one place. */
const manifest = JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8')) as {
  readonly port: number;
  readonly readyPath: string;
};
const APPLICATION_URL = `http://localhost:${String(manifest.port)}${manifest.readyPath}`;

/** The stand-in's controls, as the page sees them; `page.evaluate` cannot import the type. */
interface StandInWindow {
  readonly webSerialStandIn?: WebSerialStandInControl;
}

/** Uncaught errors and console warnings or errors of the page: any of them fails the test. */
const noise: string[] = [];

test.beforeEach(() => {
  noise.length = 0;
});

test.afterEach(() => {
  expect(noise, 'the page wrote to the console or threw').toEqual([]);
});

function listen(page: Page): void {
  page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      noise.push(`${message.type()}: ${message.text()}`);
    }
  });
}

test('opens a granted device on load, echoes a line, and survives an unplug', async ({
  context,
  page,
}) => {
  // Before the page loads: the stand-in has to be there before the library reads navigator.serial.
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted: true }],
  });
  listen(page);

  await page.goto(APPLICATION_URL);

  // Granted on an "earlier visit": the port opens without a click, and Connect never appears.
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#status')).toHaveAttribute('data-status', 'open');
  await expect(page.locator('#connect')).toHaveCount(0);
  await expect(page.locator('#send-button')).toBeEnabled();

  await page.fill('#send-input', 'PING');
  await page.click('#send-button');

  // The write is listed as sent from this tab, and the loopback's echo as received from the
  // device; the line ending (CR LF, the default) completes the received line.
  await expect(page.locator('#received li[data-kind="sent-here"]')).toContainText('PING');
  await expect(page.locator('#received li[data-direction="received"]')).toContainText('PING');
  await expect(page.locator('#send-input')).toHaveValue('');
  await expect(page.locator('#error')).toHaveCount(0);

  // Unplugging is a failure the library recovers from by itself: the error is shown as a note
  // (data-retryable) with its code and remediation, next to the reconnecting status.
  await page.evaluate(() => {
    (window as unknown as StandInWindow).webSerialStandIn?.unplug();
  });
  await expect(page.locator('#status')).toHaveText('reconnecting');
  await expect(page.locator('#error')).toHaveAttribute('data-retryable', 'true');
  await expect(page.locator('#error-code')).toHaveText('DEVICE_DISCONNECTED');
  await expect(page.locator('#error-remediation')).not.toBeEmpty();
  await expect(page.locator('#send-button')).toBeDisabled();

  await page.evaluate(() => {
    (window as unknown as StandInWindow).webSerialStandIn?.plug();
  });
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#error')).toHaveCount(0);
  await expect(page.locator('#send-button')).toBeEnabled();
});

test('asks for the device with a click, releases it and sets it up again', async ({
  context,
  page,
}) => {
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted: false }],
  });
  listen(page);

  await page.goto(APPLICATION_URL);

  // No granted port: the one status that needs the user, and the only one with a Connect button.
  await expect(page.locator('#status')).toHaveText('awaiting-permission');
  await expect(page.locator('#send-button')).toBeDisabled();

  // A real click, so the stand-in's requestPort() sees transient activation as the browser's would.
  await page.click('#connect');
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#connect')).toHaveCount(0);

  await page.fill('#send-input', 'HELLO');
  await page.click('#send-button');
  await expect(page.locator('#received li[data-direction="received"]')).toContainText('HELLO');

  // Release gives the device up in this tab; the permission stays, so setting it up again opens
  // the port without another click.
  await page.click('#release');
  await expect(page.locator('#status')).toHaveText('released');
  await expect(page.locator('#release')).toHaveCount(0);
  await expect(page.locator('#send-button')).toBeDisabled();

  await page.click('#setup-again');
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#release')).toBeVisible();
  await expect(page.locator('#error')).toHaveCount(0);
});
