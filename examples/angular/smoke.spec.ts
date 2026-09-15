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
  received: '#received li[data-direction="in"]',
  errorRemediation: '#error-remediation',
  setUpAgain: '#restart',
  failedRequestsAreNoise: true,
};

test.describe('the Angular example', () => {
  test('asks for the device on Connect, sends a line and sees the echo', async ({ context }) => {
    await installLoopback(context, false);
    const tab = await ExampleTab.open(context, UI);

    await tab.connectByClick();
    await expect(tab.locator('#send-button')).toBeEnabled();
    await tab.sendLine('PING');

    // The write is listed as sent by this tab, and the loopback's echo as received.
    await expect(tab.locator('#received li[data-direction="out"]')).toContainText('PING');
    await expect(tab.locator('#received li[data-direction="out"]')).toHaveAttribute(
      'data-local',
      'true',
    );
    await expect(tab.locator('#send-input')).toHaveValue('');
    await expect(tab.locator('#error')).toHaveCount(0);

    tab.expectQuiet();
  });

  test('recovers from an unplugged device, releases and starts again', async ({ context }) => {
    // Granted on an "earlier visit": the port opens on load, with no click.
    await installLoopback(context, true);
    const tab = await ExampleTab.open(context, UI);

    await tab.expectOpenWithoutClick();
    await tab.recoverFromUnplug();

    // Released in this tab, the configuration offers the way back, and takes it.
    await tab.releaseAndSetUpAgain();
    await tab.sendLine('AGAIN');

    tab.expectQuiet();
  });
});
