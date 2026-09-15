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
  errorRemediation: '#error-remediation',
  setUpAgain: '#restart',
};

/** Sends a line, and sees exactly one line of it in every tab given. */
async function sendLineOnce(from: ExampleTab, line: string, tabs: ExampleTab[]): Promise<void> {
  await from.locator('#send-input').fill(line);
  await from.locator('#send-button').click();
  for (const tab of tabs) {
    await expect(tab.locator('#received li', { hasText: line })).toHaveCount(1);
  }
}

test('connects on Connect, echoes a line once, shares it with a second tab, and recovers', async ({
  context,
}) => {
  await installLoopback(context, false);
  const first = await ExampleTab.open(context, UI);

  // No granted port: the status asks for the one click, in the panel and in the header alike.
  await expect(first.locator('#header-status')).toHaveText('Waiting for permission');
  await first.connectByClick();
  await expect(first.locator('#header-status')).toHaveText('Open');
  await expect(first.locator('#send-button')).toBeEnabled();

  // The loopback echoes `PING\r\n`; the hook makes one line of it - one, although StrictMode ran
  // every effect twice.
  await sendLineOnce(first, 'PING', [first]);
  await expect(first.locator('#received li').last()).toHaveAttribute('data-complete', 'true');
  await expect(first.locator('#send-input')).toHaveValue('');
  await expect(first.locator('#error')).toBeHidden();

  // A second tab: the origin is granted now, so it opens with no click, and a line it sends
  // reaches the device through whichever tab holds the port, and comes back in both.
  const second = await ExampleTab.open(context, UI);
  await second.expectStatus('open');
  await sendLineOnce(second, 'PONG', [second, first]);

  await first.recoverFromUnplug();

  // Released in the first tab: the second keeps the device. Used again, the first sets it up anew
  // and opens it with no click.
  await first.locator('#release').click();
  await first.expectStatus('released');
  await expect(first.locator('#header-status')).toHaveText('Released');
  await second.expectStatus('open');
  await first.locator('#restart').click();
  await first.expectStatus('open');
  await sendLineOnce(first, 'AGAIN', [first, second]);

  first.expectQuiet();
  second.expectQuiet();
});
