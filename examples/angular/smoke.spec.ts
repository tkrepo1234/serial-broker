/**
 * Smoke test of the Angular example, run through the repository root:
 *
 *     npm run test:examples -- examples/angular/smoke.spec.ts
 *
 * The root configuration starts the example with its `npm start` (the Angular CLI's development
 * server) on the port in `example.json`. The Web Serial stand-in replaces the device with a
 * loopback, installed before the page's own scripts run, so everything sent comes back.
 *
 * Every test fails on a page error, a console warning or error, and a failed request: an
 * application that is quiet when it works makes the one message that matters visible.
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
const url = `http://localhost:${String(manifest.port)}${manifest.readyPath}`;

/** The stand-in's controls, as the page sees them; `page.evaluate` cannot import the type. */
interface StandInWindow {
  readonly webSerialStandIn?: WebSerialStandInControl;
}

/** Opens a page and collects everything that would make the application noisy. */
async function openPage(
  context: BrowserContext,
): Promise<{ readonly page: Page; readonly noise: readonly string[] }> {
  const page = await context.newPage();
  const noise: string[] = [];
  page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      noise.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      noise.push(`${String(response.status())} ${response.url()}`);
    }
  });
  await page.goto(url);
  return { page, noise };
}

test.describe('the Angular example', () => {
  test('asks for the device on Connect, sends a line and sees the echo', async ({ context }) => {
    // Not granted: the application's own connect path is what runs. `requestPort()` - the
    // stand-in's as much as the browser's - needs the transient activation of a real click.
    await context.addInitScript(installWebSerialStandIn, {
      devices: [{ id: 'loopback', granted: false }],
    });
    const { page, noise } = await openPage(context);

    await expect(page.locator('#status')).toHaveText('awaiting-permission');
    await expect(page.locator('#send-button')).toBeDisabled();

    await page.click('#connect');
    await expect(page.locator('#status')).toHaveText('open');
    await expect(page.locator('#connect')).toHaveCount(0);
    await expect(page.locator('#send-button')).toBeEnabled();

    await page.fill('#send-input', 'PING');
    await page.click('#send-button');

    // The write is listed as sent by this tab, and the loopback's echo as received.
    await expect(page.locator('#received li[data-direction="out"]')).toContainText('PING');
    await expect(page.locator('#received li[data-direction="out"]')).toHaveAttribute(
      'data-local',
      'true',
    );
    await expect(page.locator('#received li[data-direction="in"]')).toContainText('PING');
    await expect(page.locator('#send-input')).toHaveValue('');
    await expect(page.locator('#error')).toHaveCount(0);

    expect(noise).toEqual([]);
  });

  test('recovers from an unplugged device, releases and starts again', async ({ context }) => {
    // Granted on an "earlier visit": the port opens on load, with no click.
    await context.addInitScript(installWebSerialStandIn, {
      devices: [{ id: 'loopback', granted: true }],
    });
    const { page, noise } = await openPage(context);

    await expect(page.locator('#status')).toHaveText('open');
    await expect(page.locator('#connect')).toHaveCount(0);

    // Unplugging is a failure the library recovers from by itself: the error is shown as a note
    // next to the reconnecting status, and cleared once the port is open again.
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

    // Released in this tab, the configuration offers the way back, and takes it.
    await page.click('#release');
    await expect(page.locator('#status')).toHaveText('released');
    await expect(page.locator('#send-button')).toBeDisabled();
    await page.click('#restart');
    await expect(page.locator('#status')).toHaveText('open');

    await page.fill('#send-input', 'AGAIN');
    await page.click('#send-button');
    await expect(page.locator('#received li[data-direction="in"]')).toContainText('AGAIN');

    expect(noise).toEqual([]);
  });
});
