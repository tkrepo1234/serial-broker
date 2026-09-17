/**
 * Smoke test of the minimal JavaScript example, run through the repository root:
 *
 *     npm run test:examples -- examples/minimal-js/smoke.spec.ts
 *
 * The root configuration starts the example with its `npm start` on the port `example.json` names.
 * The Web Serial stand-in replaces the device with a loopback the origin has *not* been granted, so
 * the page's connect button is what opens the port - the one step of the integration that needs
 * the user, and the one this example exists to show.
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
  // The page keeps to the usual ids. It is the smallest page that works: an error is one line of
  // text, with no element of its own for the code, so `errorCode` is left out.
};

test('connects from a click, echoes a line and stays quiet', async ({ context }) => {
  await installLoopback(context);
  const tab = await ExampleTab.open(context, UI);

  await tab.connectByClick();
  await expect(tab.locator('#send-button')).toBeEnabled();

  await tab.sendLine('PING');
  await expect(tab.locator('#send-input')).toHaveValue('');
  await expect(tab.locator('#error')).toBeEmpty();

  tab.expectQuiet();
});

test('shows an unplugged device, and takes the error away once the port is open again', async ({
  context,
}) => {
  await installLoopback(context);
  const tab = await ExampleTab.open(context, UI);
  await tab.connectByClick();

  // The error line says what happened while the library reconnects, and is empty again afterwards:
  // an error left standing under an `open` status would contradict it.
  await tab.recoverFromUnplug();
  await tab.sendLine('AFTER THE DEVICE CAME BACK');
});
