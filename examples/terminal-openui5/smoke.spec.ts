/**
 * The OpenUI5 terminal, driven in a real browser with the Web Serial stand-in in place of a device.
 *
 * Run through the repository root, which starts the example on its own port first
 * (examples/README.md): `npm run test:examples -- examples/terminal-openui5/smoke.spec.ts`.
 *
 * UI5 renders asynchronously and after the page's `load` event, so nothing is looked for by
 * position: every control has a fixed id, listed in README.md, and every expectation waits for it.
 * The page fixes its own language to English (index.html), so the texts asserted here do not depend
 * on the machine the browser runs on.
 *
 * The last test is the reason this example exists: it builds the application and opens the built
 * folder from a file, with no server behind it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  ExampleTab,
  installLoopback,
  type ExampleManifest,
  type ExampleUi,
} from '../smoke-support.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.join(HERE, 'example.json'), 'utf8'),
) as ExampleManifest & {
  readonly readyPath: string;
};

/** The DOM ids README.md documents: `<container id>-<component id>---<view id>--<control id>`. */
const ID = '#container-terminal---app--';

const UI: ExampleUi = {
  url: `http://localhost:${String(manifest.port)}${manifest.readyPath}`,
  statusIn: 'text',
  // The text inside the status badge: the badge itself also carries its state for screen readers.
  status: `${ID}status-text`,
  connect: `${ID}connect`,
  // `sap.m.Input` wraps the element that takes the text; `-inner` is that element.
  sendInput: `${ID}sendInput-inner`,
  sendButton: `${ID}sendButton`,
  received: '#received',
  error: `${ID}error`,
  errorCode: `${ID}errorCode`,
  errorRemediation: `${ID}errorRemediation`,
  // Disconnect and Connect again are the same button: releasing is what a terminal calls
  // disconnecting, and the page then offers to connect again in its place.
  release: `${ID}release`,
  setUpAgain: `${ID}release`,
};

test('connects to a granted device, sends a line and sees it echoed', async ({ context }) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);

  await tab.expectOpenWithoutClick();
  await expect(tab.locator(UI.error)).toBeHidden();

  // The loopback echoes what is written, so the line comes back into the log; the terminal also
  // shows what this tab sent, marked as outgoing.
  await tab.sendLine('HELLO FROM OPENUI5');
  await expect(tab.locator('#received')).toContainText('» HELLO FROM OPENUI5');

  tab.expectQuiet();
});

test('asks for a device with a click when none was granted', async ({ context }) => {
  await installLoopback(context, false);
  const tab = await ExampleTab.open(context, UI);

  await tab.connectByClick();
  await tab.sendLine('AFTER THE PICKER');

  tab.expectQuiet();
});

test('lives through an unplugged adapter, and disconnects and connects again', async ({
  context,
}) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);
  await tab.expectOpenWithoutClick();

  await tab.recoverFromUnplug();
  await tab.sendLine('AFTER THE ADAPTER CAME BACK');

  await tab.releaseAndSetUpAgain(async () => {
    await expect(tab.locator(`${ID}release`)).toHaveText('Connect again');
  });
  await tab.sendLine('AFTER CONNECTING AGAIN');
});

test('reads and writes hex, and keeps the display options between visits', async ({ context }) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);
  await tab.expectOpenWithoutClick();

  // Hex in, hex out: the input is read as bytes and the log shows a dump of what comes back.
  await tab.locator(`${ID}display`).click();
  await tab.locator(`${ID}optHex`).click();
  await tab.page.keyboard.press('Escape');
  await tab.locator(`${ID}sendMode`).click();
  await tab.page.getByRole('option', { name: 'Hex' }).click();
  // Hex input is the bytes and nothing else, so the line ending cannot be chosen.
  await expect(tab.locator(`${ID}sendEnding`)).toHaveClass(/sapMSltDisabled/);
  await tab.locator(UI.sendInput).fill('41 42 43');
  await tab.locator(UI.sendButton).click();

  // 41 42 43 is ABC, which the dump shows beside the bytes.
  await expect(tab.locator('#received')).toContainText('41 42 43');
  await expect(tab.locator('#received')).toContainText('ABC');

  // The preference survives a reload, because a terminal that forgets its display on every visit
  // is a terminal nobody keeps open.
  await tab.page.reload();
  await expect(tab.locator(`${ID}displaySummary`)).toContainText('hex');
});

test('changes the baud rate in the settings dialog and connects again with it', async ({
  context,
}) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);
  await tab.expectOpenWithoutClick();

  await tab.locator(`${ID}settings`).click();
  // A combo box: the usual rates are offered, and any other can be typed.
  await tab.locator(`${ID}baudRate-inner`).fill('250000');
  await tab.locator(`${ID}settingsApply`).click();

  await tab.expectStatus('open');
  await expect(tab.locator(`${ID}displaySummary`)).toContainText('250000 baud');
  await tab.sendLine('AT THE NEW RATE');
});

test('the built folder runs when opened as a file, with no web server, and shares the port', async ({
  context,
}) => {
  // The build takes half a minute: a self-contained OpenUI5 bundle, then scripts/finish-build.mjs,
  // which embeds what the framework would otherwise fetch - a page opened from a file may not.
  test.setTimeout(420_000);
  execFileSync('npm', ['run', 'build'], { cwd: HERE, stdio: 'ignore', shell: true });
  const url = pathToFileURL(path.join(HERE, 'dist', 'index.html')).href;

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
    await expect(tab.locator(UI.error)).toBeHidden();
    // Nothing the framework asked for was refused: no text bundle, no locale data, no module.
    tab.expectQuiet();
  }
});
