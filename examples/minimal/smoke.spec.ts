/**
 * Smoke test of the minimal example, run through the repository root:
 *
 *     npm run test:examples -- examples/minimal/smoke.spec.ts
 *
 * The root configuration starts the example with its `npm start` on port 8151. The Web Serial
 * stand-in replaces the device with a loopback that the origin was granted on an earlier visit,
 * so the page connects on load with no click, and everything sent comes back.
 */
import { expect, test } from '@playwright/test';

import { installWebSerialStandIn } from '../../test/browser/stand-in/web-serial-stand-in.js';

test('connects on load, sends a line and sees it echoed', async ({ browser }) => {
  const context = await browser.newContext();
  // Before the first page: the stand-in has to be there before the page's own script runs.
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted: true }],
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const consoleNoise: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      consoleNoise.push(`${message.type()}: ${message.text()}`);
    }
  });

  await page.goto('http://localhost:8151/');

  // The device is already granted, so the page opens the port without a click.
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#connect')).toBeHidden();
  await expect(page.locator('#send-button')).toBeEnabled();

  await page.fill('#send-input', 'PING');
  await page.click('#send-button');

  // The loopback echoes what was written, line ending included.
  await expect(page.locator('#received')).toContainText('PING');
  await expect(page.locator('#send-input')).toHaveValue('');
  await expect(page.locator('#error')).toBeHidden();

  expect(pageErrors).toEqual([]);
  expect(consoleNoise).toEqual([]);

  await context.close();
});
