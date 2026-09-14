/**
 * Smoke test of the React example, run through the repository root:
 *
 *     npm run test:examples -- examples/react/smoke.spec.ts
 *
 * The root configuration starts the example with its `npm start` on port 8155 - Vite's development
 * server, so React runs in StrictMode with every effect doubled. That is part of what is tested: a
 * hook that subscribed twice would show every echoed line twice.
 *
 * The Web Serial stand-in replaces the device with a loopback. Its device is not granted
 * beforehand, so the one click the application needs is part of the run: `requestPort()`, the
 * stand-in's as much as the browser's, needs the transient activation of a real click.
 */
import { readFileSync } from 'node:fs';

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  installWebSerialStandIn,
  type WebSerialStandInControl,
} from '../../test/browser/stand-in/web-serial-stand-in.js';

/** The manifest the root reads, so the port lives in one place. */
const manifest = JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8')) as {
  readonly port: number;
  readonly readyPath: string;
};

const URL_OF_PAGE = `http://localhost:${String(manifest.port)}${manifest.readyPath}`;

/** The stand-in's controls, as the page sees them; `page.evaluate` cannot import the type. */
interface StandInWindow {
  readonly webSerialStandIn?: WebSerialStandInControl;
}

/** Opens a page that records its errors and every console warning or error. */
async function openPage(context: BrowserContext, noise: string[]): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      noise.push(`${message.type()}: ${message.text()}`);
    }
  });
  await page.goto(URL_OF_PAGE);
  return page;
}

test('connects on Connect, echoes a line once, shares it with a second tab, and recovers', async ({
  browser,
}) => {
  const context = await browser.newContext();
  // Before the first page: the stand-in has to be there before the page's own script runs.
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted: false }],
  });
  const noise: string[] = [];
  const first = await openPage(context, noise);

  // No granted port: the status asks for the one click, in the panel and in the header alike.
  await expect(first.locator('#status')).toHaveText('awaiting-permission');
  await expect(first.locator('#header-status')).toHaveText('Waiting for permission');
  await expect(first.locator('#send-button')).toBeDisabled();

  await first.locator('#connect').click();
  await expect(first.locator('#status')).toHaveText('open');
  await expect(first.locator('#header-status')).toHaveText('Open');
  await expect(first.locator('#connect')).toBeHidden();
  await expect(first.locator('#send-button')).toBeEnabled();

  // The loopback echoes `PING\r\n`; the hook makes one line of it - one, although StrictMode ran
  // every effect twice.
  await first.fill('#send-input', 'PING');
  await first.click('#send-button');
  await expect(first.locator('#received li', { hasText: 'PING' })).toHaveCount(1);
  await expect(first.locator('#received li').last()).toHaveAttribute('data-complete', 'true');
  await expect(first.locator('#send-input')).toHaveValue('');
  await expect(first.locator('#error')).toBeHidden();

  // A second tab: the origin is granted now, so it opens with no click, and a line it sends
  // reaches the device through whichever tab holds the port, and comes back in both.
  const second = await openPage(context, noise);
  await expect(second.locator('#status')).toHaveText('open');
  await second.fill('#send-input', 'PONG');
  await second.click('#send-button');
  await expect(second.locator('#received li', { hasText: 'PONG' })).toHaveCount(1);
  await expect(first.locator('#received li', { hasText: 'PONG' })).toHaveCount(1);

  // Unplugged: a failure the library recovers from by itself, shown as a note next to
  // `reconnecting`, and cleared once the port is open again.
  await first.evaluate(() => {
    (window as unknown as StandInWindow).webSerialStandIn?.unplug();
  });
  await expect(first.locator('#status')).toHaveText('reconnecting');
  await expect(first.locator('#error')).toHaveAttribute('data-retryable', 'true');
  await expect(first.locator('#error-code')).toHaveText('DEVICE_DISCONNECTED');
  await expect(first.locator('#error-remediation')).not.toBeEmpty();
  await expect(first.locator('#send-button')).toBeDisabled();
  await first.evaluate(() => {
    (window as unknown as StandInWindow).webSerialStandIn?.plug();
  });
  await expect(first.locator('#status')).toHaveText('open');
  await expect(first.locator('#error')).toBeHidden();

  // Released in the first tab: the second keeps the device. Used again, the first sets it up anew
  // and opens it with no click.
  await first.click('#release');
  await expect(first.locator('#status')).toHaveText('released');
  await expect(first.locator('#header-status')).toHaveText('Released');
  await expect(second.locator('#status')).toHaveText('open');
  await first.click('#restart');
  await expect(first.locator('#status')).toHaveText('open');
  await first.fill('#send-input', 'AGAIN');
  await first.click('#send-button');
  await expect(first.locator('#received li', { hasText: 'AGAIN' })).toHaveCount(1);
  await expect(second.locator('#received li', { hasText: 'AGAIN' })).toHaveCount(1);

  expect(noise).toEqual([]);
  await context.close();
});
