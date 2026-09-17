/**
 * The terminal example, driven in a real browser with the Web Serial stand-in in place of a
 * device. Started and run through the repository root: `npm run test:examples --
 * examples/terminal/smoke.spec.ts`. See examples/README.md for the contract.
 */

import { cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import { ExampleTab, installLoopback, USUAL_IDS, type ExampleUi } from '../smoke-support.js';

const ORIGIN = 'http://localhost:8161';

const UI: ExampleUi = {
  ...USUAL_IDS,
  url: `${ORIGIN}/`,
  sendButton: '#send-button',
  // Disconnect and Connect again are the same button: releasing is what a terminal calls
  // disconnecting, and the page then offers to connect again in its place.
  release: '#release',
  setUpAgain: '#release',
  errorRemediation: '#error-remediation',
};

test('connects to a granted device, sends a line and sees it echoed', async ({ context }) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);

  await tab.expectOpenWithoutClick();
  await expect(tab.locator('#error')).toBeHidden();

  // The loopback echoes what is written, so the line comes back into the log; the terminal also
  // shows what this tab sent, marked as outgoing.
  await tab.sendLine('HELLO FROM THE TERMINAL');
  await expect(tab.locator('#received')).toContainText('» HELLO FROM THE TERMINAL');

  tab.expectQuiet();
});

test('asks for a device with a click when none was granted', async ({ context }) => {
  await installLoopback(context, false);
  const tab = await ExampleTab.open(context, UI);

  await tab.connectByClick();
  await tab.sendLine('AFTER THE PICKER');

  tab.expectQuiet();
});

test('shows an unplugged device as a note, and recovers', async ({ context }) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);
  await tab.expectOpenWithoutClick();

  await tab.recoverFromUnplug();
  await tab.sendLine('AFTER THE REPLUG');

  tab.expectQuiet();
});

test('disconnects in this tab and connects again', async ({ context }) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);
  await tab.expectOpenWithoutClick();

  await tab.releaseAndSetUpAgain(async () => {
    await expect(tab.locator('#release')).toHaveText('Connect again');
  });
  await tab.sendLine('AFTER RECONNECTING');

  tab.expectQuiet();
});

test('reads and writes hex, and keeps the display options between visits', async ({ context }) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);
  await tab.expectOpenWithoutClick();

  // Hex in, hex out: the input is read as bytes and the log shows a dump of what comes back.
  await tab.locator('#more').click();
  await tab.locator('#opt-hex').check();
  await tab.page.keyboard.press('Escape');
  await tab.locator('#send-mode').selectOption('hex');
  await tab.locator('#send-input').fill('41 42 43');
  await tab.locator('#send-button').click();

  // 41 42 43 is ABC, which the dump shows beside the bytes.
  await expect(tab.locator('#received')).toContainText('41 42 43');
  await expect(tab.locator('#received')).toContainText('ABC');

  // The preference survives a reload, because a terminal that forgets its display on every visit
  // is a terminal nobody keeps open.
  await tab.page.reload();
  await expect(tab.locator('#opt-hex')).toBeChecked();
  await expect(tab.locator('#display-summary')).toContainText('hex');

  tab.expectQuiet();
});

test('runs from a folder opened as a file, with no web server, and shares the port between tabs', async ({
  context,
}, testInfo) => {
  // What `npm run build` assembles, put together here so the test needs no build of its own: the
  // page, and the two library files it loads, side by side in one folder.
  const folder = testInfo.outputPath('terminal');
  const here = path.dirname(fileURLToPath(import.meta.url));
  await cp(path.join(here, 'public'), folder, { recursive: true });
  for (const file of ['serial-broker.global.js', 'serial-broker.worker.js']) {
    await cp(
      path.join(here, 'node_modules', 'serial-broker', 'dist', file),
      path.join(folder, 'serial-broker', file),
    );
  }
  const url = pathToFileURL(path.join(folder, 'index.html')).href;

  await installLoopback(context, true);
  const tabs = [
    await ExampleTab.open(context, { ...UI, url }),
    await ExampleTab.open(context, { ...UI, url }),
  ];
  for (const tab of tabs) {
    await tab.expectOpenWithoutClick();
  }

  // A page opened from a file may start no SharedWorker; the library coordinates the tabs over a
  // BroadcastChannel instead. What the operator sees is the same: one port, both tabs.
  await tabs[1]?.sendLine('HELLO FROM A FILE');
  for (const tab of tabs) {
    await expect(tab.locator('#received')).toContainText('HELLO FROM A FILE');
    await expect(tab.locator('#error')).toBeHidden();
  }
});
