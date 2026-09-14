/**
 * The no-bundler example, driven in a real browser with the Web Serial stand-in in place of a
 * device. Started and run through the repository root: `npm run test:examples --
 * examples/no-bundler/smoke.spec.ts`. See examples/README.md for the contract.
 */

import { expect, test } from '@playwright/test';

import { GRANTED_DEVICE, installStandIn } from '../../test/browser/support/tab.js';

const ORIGIN = 'http://localhost:8154';

test('connects to a granted device, sends a line and sees it echoed', async ({ context }) => {
  // The device was granted on an earlier visit, so the page opens it with no click: that is the
  // normal case in production, and `?stand-in` is not needed - the stand-in comes from the test.
  await installStandIn(context, GRANTED_DEVICE);

  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleNoise: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'warning' || message.type() === 'error') {
      consoleNoise.push(`${message.type()}: ${message.text()}`);
    }
  });

  await page.goto(`${ORIGIN}/`);
  await expect(page.locator('#status')).toHaveText('open');
  await expect(page.locator('#connect')).toBeHidden();
  await expect(page.locator('#error')).toBeHidden();

  await page.fill('#send-input', 'HELLO FROM THE PAGE');
  await page.click('#send');
  // The loopback device echoes what is written, line ending included.
  await expect(page.locator('#received')).toContainText('HELLO FROM THE PAGE');
  await expect(page.locator('#sent')).toContainText('this tab');

  // The page and the library are quiet: nothing uncaught, nothing on the console.
  expect(pageErrors).toEqual([]);
  expect(consoleNoise).toEqual([]);
});
