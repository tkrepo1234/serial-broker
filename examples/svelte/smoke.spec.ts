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
import { expect, test } from '@playwright/test';

import { ExampleTab, installLoopback, USUAL_IDS, type ExampleUi } from '../smoke-support.js';

const UI: ExampleUi = {
  ...USUAL_IDS,
  url: 'http://localhost:8157/',
  errorRemediation: '#error-remediation',
  release: '#release',
  setUpAgain: '#restart',
};

/** Sends a line, and sees it echoed and the input cleared. */
async function sendLine(tab: ExampleTab, line: string): Promise<void> {
  await tab.sendLine(line);
  await expect(tab.locator('#send-input')).toHaveValue('');
}

test('connects on load, echoes a line, and survives the device being unplugged', async ({
  context,
}) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);

  await tab.expectOpenWithoutClick();
  await expect(tab.locator('#send-button')).toBeEnabled();
  await sendLine(tab, 'PING');
  // PING and CR LF: six bytes out, the same six back.
  await expect(tab.locator('#counters')).toHaveText('6 bytes received, 6 bytes sent by any tab');
  await expect(tab.locator('#error')).toBeHidden();

  await tab.recoverFromUnplug(async () => {
    await expect(tab.locator('#error-recovering')).toBeVisible();
  });
  await sendLine(tab, 'AGAIN');

  tab.expectQuiet();
});

test('asks for the device with the connect button, and only then', async ({ context }) => {
  await installLoopback(context, false);
  const tab = await ExampleTab.open(context, UI);

  await expect(tab.locator('#error')).toBeHidden();
  await tab.connectByClick();
  await sendLine(tab, 'HELLO');

  tab.expectQuiet();
});

test('releases in one tab while the other keeps the device, and sets up again', async ({
  context,
}) => {
  await installLoopback(context, true);
  const first = await ExampleTab.open(context, UI);
  await first.expectStatus('open');
  const second = await ExampleTab.open(context, UI);
  await second.expectStatus('open');

  // Both tabs receive what either sends, whichever holds the port.
  await sendLine(first, 'FROM FIRST');
  await expect(second.locator('#received')).toContainText('FROM FIRST');

  await first.locator('#release').click();
  await first.expectStatus('released');
  await expect(first.locator('#release')).toBeHidden();
  await expect(first.locator('#restart')).toBeVisible();
  await expect(first.locator('#send-button')).toBeDisabled();

  // The other tab keeps the device, and takes the port over if the first held it.
  await second.expectStatus('open');
  await sendLine(second, 'FROM SECOND');
  await expect(first.locator('#received')).not.toContainText('FROM SECOND');

  await first.locator('#restart').click();
  await first.expectStatus('open');
  await expect(first.locator('#restart')).toBeHidden();
  await sendLine(first, 'BACK');
  await expect(second.locator('#received')).toContainText('BACK');

  first.expectQuiet();
  second.expectQuiet();
});
