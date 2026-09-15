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

import { expect, test } from '@playwright/test';

import {
  ExampleTab,
  installLoopback,
  urlOfExample,
  USUAL_IDS,
  type ExampleManifest,
  type ExampleUi,
} from '../smoke-support.js';

const UI: ExampleUi = {
  ...USUAL_IDS,
  url: urlOfExample(
    JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8')) as ExampleManifest,
  ),
  // The write is listed as sent from this tab, and the loopback's echo as received from the device.
  received: '#received li[data-direction="received"]',
  errorRemediation: '#error-remediation',
  setUpAgain: '#setup-again',
};

test('opens a granted device on load, echoes a line, and survives an unplug', async ({
  context,
}) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);

  await tab.expectOpenWithoutClick();
  await expect(tab.locator('#status')).toHaveAttribute('data-status', 'open');
  await expect(tab.locator('#send-button')).toBeEnabled();
  await tab.sendLine('PING');
  await expect(tab.locator('#received li[data-kind="sent-here"]')).toContainText('PING');
  await expect(tab.locator('#send-input')).toHaveValue('');
  await expect(tab.locator('#error')).toHaveCount(0);

  await tab.recoverFromUnplug();
  await expect(tab.locator('#send-button')).toBeEnabled();

  tab.expectQuiet();
});

test('asks for the device with a click, releases it and sets it up again', async ({ context }) => {
  await installLoopback(context, false);
  const tab = await ExampleTab.open(context, UI);

  await tab.connectByClick();
  await tab.sendLine('HELLO');

  // Release gives the device up in this tab; the permission stays, so setting it up again opens
  // the port without another click.
  await tab.releaseAndSetUpAgain(async () => {
    await expect(tab.locator('#release')).toHaveCount(0);
  });
  await expect(tab.locator('#release')).toBeVisible();
  await expect(tab.locator('#error')).toHaveCount(0);

  tab.expectQuiet();
});
