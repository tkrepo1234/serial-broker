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
 * The terminal's connection handling is one button. *Connect* shows the connection settings and
 * then asks for the port; *Disconnect* forgets everything. The stand-in's device is therefore never
 * granted beforehand: every connection here goes through the picker, as it does for a user.
 *
 * The last test is the reason this example exists: it builds the application and opens the built
 * folder from a file, with no server behind it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect, test, type BrowserContext } from '@playwright/test';

import type { WebSerialStandInControl } from '../../test/browser/stand-in/web-serial-stand-in.js';
import {
  ExampleTab,
  installLoopback,
  urlOfExample,
  type ExampleManifest,
  type ExampleUi,
} from '../smoke-support.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  readFileSync(path.join(HERE, 'example.json'), 'utf8'),
) as ExampleManifest;

/** The DOM ids README.md documents: `<container id>-<component id>---<view id>--<control id>`. */
const ID = '#container-terminal---app--';

/** The stand-in's controls, as the page sees them; `page.evaluate` cannot import the type. */
type StandInWindow = { readonly webSerialStandIn: WebSerialStandInControl };

const UI: ExampleUi = {
  url: urlOfExample(manifest),
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
};

/** Opens the terminal, which connects to nothing until it is told to. */
async function open(context: BrowserContext, ui: ExampleUi = UI): Promise<ExampleTab> {
  await installLoopback(context);
  const tab = await ExampleTab.open(context, ui);
  await tab.expectStatus('disconnected');
  await expect(tab.locator(ui.connect)).toHaveText('Connect');
  await expect(tab.locator(ui.sendButton)).toBeDisabled();
  return tab;
}

/** *Connect*, the settings as they are, *Connect*: the port is asked for and opened. */
async function connect(tab: ExampleTab): Promise<void> {
  await tab.locator(UI.connect).click();
  await tab.locator(`${ID}connectConfirm`).click();
  await tab.expectStatus('open');
  await expect(tab.locator(UI.connect)).toHaveText('Disconnect');
}

function isGranted(tab: ExampleTab): Promise<boolean> {
  return tab.page.evaluate(() => (window as unknown as StandInWindow).webSerialStandIn.isGranted());
}

/** Opens the display popover, turns one option on or off, and closes it again. */
async function toggleDisplayOption(tab: ExampleTab, option: string): Promise<void> {
  await tab.locator(`${ID}display`).click();
  await tab.locator(`${ID}${option}`).click();
  await tab.page.keyboard.press('Escape');
}

/** Switches the composer to hex, which is a select with the modes as its options. */
async function chooseHexMode(tab: ExampleTab): Promise<void> {
  await tab.locator(`${ID}sendMode`).click();
  await tab.page.getByRole('option', { name: 'Hex' }).click();
}

test('connects through the settings dialog, sends a line and sees it echoed', async ({
  context,
}) => {
  const tab = await open(context);

  await tab.locator(UI.connect).click();
  // The dialog is what Connect always shows, with the settings of the last time.
  await expect(tab.locator(`${ID}baudRate-inner`)).toHaveValue('9600');
  await tab.locator(`${ID}connectConfirm`).click();
  await tab.expectStatus('open');
  await expect(tab.locator(UI.error)).toBeHidden();

  // The loopback echoes what is written, so the line comes back into the log; the terminal also
  // shows what this tab sent, marked as outgoing.
  await tab.sendLine('HELLO FROM OPENUI5');
  await expect(tab.locator('#received')).toContainText('» HELLO FROM OPENUI5');

  tab.expectQuiet();
});

test('keeps line settings the library refused out of the summary and out of the next visit', async ({
  context,
}) => {
  const tab = await open(context);

  await tab.locator(UI.connect).click();
  await tab.locator(`${ID}baudRate-inner`).fill('99999999');
  await tab.locator(`${ID}connectConfirm`).click();

  // The library has the verdict on the settings, and says why in the dialog, which stays open.
  await expect(tab.locator(`${ID}connectMessage`)).toContainText('INVALID_ARGUMENT');
  await expect(tab.locator(`${ID}settingsDialog`)).toBeVisible();
  await tab.locator(`${ID}settingsCancel`).click();

  // Nothing about that attempt is kept: the summary describes no connection it has not made, and
  // the rate is not offered again - it would fail the same way on every visit from now on.
  await expect(tab.locator(`${ID}displaySummary`)).toContainText('9600 baud');
  await expect(tab.locator(`${ID}displaySummary`)).not.toContainText('99999999');
  await tab.locator(UI.connect).click();
  await expect(tab.locator(`${ID}baudRate-inner`)).toHaveValue('9600');
});

test('says that hex the composer cannot read is the line, not the page', async ({ context }) => {
  const tab = await open(context);
  await connect(tab);

  await chooseHexMode(tab);
  await tab.locator(UI.sendInput).fill('zz');
  await tab.locator(UI.sendButton).click();

  await expect(tab.locator(`${ID}errorCode`)).toHaveText('Invalid input');
  await expect(tab.locator(`${ID}errorMessage`)).toContainText('even number of digits');
  await expect(tab.locator(`${ID}errorRemediation`)).toContainText('Correct the line');
});

test('offers the file dialog again after it has been used once', async ({ context }) => {
  const tab = await open(context);
  await connect(tab);
  const file = { name: 'payload.txt', mimeType: 'text/plain', buffer: Buffer.from('one line\n') };

  const openDialog = async (): Promise<void> => {
    await tab.locator(`${ID}more`).click();
    await tab.locator(`${ID}fileTransfer`).click();
    await expect(tab.locator(`${ID}fileDialog`)).toBeVisible();
  };

  await openDialog();
  await tab.locator(`${ID}fileInput`).locator('input[type="file"]').setInputFiles(file);
  await expect(tab.locator(`${ID}fileSend`)).toBeEnabled();
  await tab.locator(`${ID}fileClose`).click();

  // The control keeps what it was given, so choosing the same file again fires no event of its
  // own: the dialog has to start from nothing, or Send never becomes available again.
  await openDialog();
  await expect(tab.locator(`${ID}fileSend`)).toBeDisabled();
  await tab.locator(`${ID}fileInput`).locator('input[type="file"]').setInputFiles(file);
  await expect(tab.locator(`${ID}fileSend`)).toBeEnabled();
});

test('offers the usual baud rates, takes any other, and shows the last settings next time', async ({
  context,
}) => {
  const tab = await open(context);

  await tab.locator(UI.connect).click();
  // A combo box: the usual rates are offered whatever the field holds, and any other can be typed.
  await tab.locator(`${ID}baudRate-arrow`).click();
  await expect(tab.page.getByRole('option')).toHaveCount(12);
  await tab.page.keyboard.press('Escape');
  await tab.locator(`${ID}baudRate-inner`).fill('250000');
  await tab.locator(`${ID}connectConfirm`).click();
  await tab.expectStatus('open');
  await expect(tab.locator(`${ID}displaySummary`)).toContainText('250000 baud');
  await tab.sendLine('AT THE NEW RATE');

  // Disconnected, and after a reload as well, the dialog shows what was used last; cancelling it
  // connects nothing.
  await tab.locator(UI.connect).click();
  await tab.expectStatus('disconnected');
  await tab.page.reload();
  await tab.locator(UI.connect).click();
  await expect(tab.locator(`${ID}baudRate-inner`)).toHaveValue('250000');
  await tab.locator(`${ID}settingsCancel`).click();
  await tab.expectStatus('disconnected');
});

test('forgets everything on Disconnect, so the next Connect asks for the port again', async ({
  context,
}) => {
  const tab = await open(context);
  await connect(tab);
  expect(await isGranted(tab)).toBe(true);

  await tab.locator(UI.connect).click();
  await tab.expectStatus('disconnected');
  await expect(tab.locator(UI.connect)).toHaveText('Connect');
  await expect(tab.locator(UI.sendButton)).toBeDisabled();
  await expect(tab.locator('#received')).toContainText(
    'The port and the remembered connection are forgotten.',
  );
  // The browser's permission went back, and serial-broker remembers nothing under the name.
  expect(await isGranted(tab)).toBe(false);
  // (Its index of names stays, and no longer lists this one.)
  expect(
    await tab.page.evaluate(() =>
      Object.entries(window.localStorage)
        .filter(([key]) => key.startsWith('serial-broker/'))
        .map(([key, value]) => (key.endsWith('/index') ? String(value) : key))
        .filter((entry) => entry.includes('Terminal')),
    ),
  ).toEqual([]);

  // Which is also how the port is changed: connect again, and the picker is asked again.
  await connect(tab);
  expect(await isGranted(tab)).toBe(true);
  await tab.sendLine('ON THE PORT CHOSEN AGAIN');
});

test('keeps the dialog open when no port is chosen, and connects from it once one is', async ({
  context,
}) => {
  const tab = await open(context);
  // Nothing to choose from: the picker has no port to offer, as when the user dismisses it.
  await tab.page.evaluate(() => {
    (window as unknown as StandInWindow).webSerialStandIn.unplug();
  });

  await tab.locator(UI.connect).click();
  await tab.locator(`${ID}baudRate-inner`).fill('19200');
  await tab.locator(`${ID}connectConfirm`).click();

  // The dialog does not go away with the picker: the settings are still there, it says why there
  // is no connection, and nothing is set up behind it.
  await expect(tab.locator(`${ID}connectMessage`)).toContainText('No port was chosen');
  await expect(tab.locator(`${ID}settingsDialog`)).toBeVisible();
  await expect(tab.locator(`${ID}baudRate-inner`)).toHaveValue('19200');
  await tab.expectStatus('disconnected');

  // Asked again from the same dialog, with a port to choose this time.
  await tab.page.evaluate(() => {
    (window as unknown as StandInWindow).webSerialStandIn.plug();
  });
  await tab.locator(`${ID}connectConfirm`).click();
  await tab.expectStatus('open');
  await expect(tab.locator(`${ID}settingsDialog`)).toBeHidden();
  await expect(tab.locator(`${ID}displaySummary`)).toContainText('19200 baud');
});

test('lives through an unplugged adapter', async ({ context }) => {
  const tab = await open(context);
  await connect(tab);

  await tab.recoverFromUnplug();
  await tab.sendLine('AFTER THE ADAPTER CAME BACK');
});

test('reads and writes hex, and keeps the display options between visits', async ({ context }) => {
  const tab = await open(context);
  await connect(tab);

  // Hex in, hex out: the input is read as bytes and the log shows a dump of what comes back.
  await toggleDisplayOption(tab, 'optHex');
  await chooseHexMode(tab);
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

test('walks what was sent with the arrow keys, each entry in its mode, and keeps the focus', async ({
  context,
}) => {
  const tab = await open(context);
  await connect(tab);
  const input = tab.locator(UI.sendInput);

  await tab.sendLine('AS TEXT');
  await chooseHexMode(tab);
  await input.fill('41 42');
  await tab.locator(UI.sendButton).click();
  await expect(tab.locator('#received')).toContainText('AB');

  // Up: the hex entry, in hex. Up again: the text entry - and the mode follows it, while the field
  // keeps the focus: the keys do not reach the toolbar, which would move the focus to the select.
  await input.click();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('41 42');
  await expect(input).toBeFocused();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('AS TEXT');
  await expect(tab.locator(`${ID}sendMode`)).toContainText('Text');
  await expect(input).toBeFocused();
  await input.press('ArrowDown');
  await expect(input).toHaveValue('41 42');
  await expect(tab.locator(`${ID}sendMode`)).toContainText('Hex');
  await expect(input).toBeFocused();
  // Past the newest entry: the empty line, in the mode that is set.
  await input.press('ArrowDown');
  await expect(input).toHaveValue('');
  await expect(input).toBeFocused();
});

test('keeps the log the size it is, however much arrives and however long a line is', async ({
  context,
}) => {
  const tab = await open(context);
  await connect(tab);

  const log = tab.locator('#received');
  // Measured once the page has settled: the first line is in, and the header has its final height.
  await tab.sendLine('the first line');
  const before = await log.boundingBox();

  // Many lines, a line too long to fit, and a word too long to break at a space.
  for (let line = 0; line < 40; line += 1) {
    await tab.locator(UI.sendInput).fill(`line ${String(line)} ${'ABCDEFGHIJ '.repeat(12)}`);
    await tab.locator(UI.sendButton).click();
  }
  await tab.sendLine('X'.repeat(400));

  // The box is where it was and as large as it was: what does not fit scrolls inside it, the newest
  // line is in view, and the line to type into has not been pushed out of the window.
  expect(await log.boundingBox()).toEqual(before);
  expect(
    await log.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
    ),
  ).toBeLessThan(4);
  expect(
    await tab.page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight),
  ).toBe(true);
  await expect(tab.locator(UI.sendInput)).toBeInViewport();
});

test('leaves the log where the reader put it while auto-scroll is off', async ({ context }) => {
  const tab = await open(context);
  await connect(tab);
  const log = tab.locator('#received');
  const send = async (count: number): Promise<void> => {
    for (let line = 0; line < count; line += 1) {
      await tab.sendLine(`line ${String(line)} ${'ABCDEFGHIJ '.repeat(12)}`);
    }
  };
  const fromTheEnd = (): Promise<number> =>
    log.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);

  await send(20);
  expect(await fromTheEnd()).toBeLessThan(4);

  // Off means off, at the end of the log as much as in the middle of it: the reader is reading.
  await toggleDisplayOption(tab, 'optAutoscroll');
  const at = await log.evaluate((element) => element.scrollTop);
  await send(5);
  expect(await log.evaluate((element) => element.scrollTop)).toBe(at);
  expect(await fromTheEnd()).toBeGreaterThan(20);

  // On again, the log follows from wherever it was left.
  await log.evaluate((element) => {
    element.scrollTop = 0;
  });
  await toggleDisplayOption(tab, 'optAutoscroll');
  await send(1);
  expect(await fromTheEnd()).toBeLessThan(4);
});

test('shares the port between two tabs, and a Disconnect in one disconnects the other', async ({
  context,
}) => {
  const first = await open(context);
  await connect(first);
  const second = await ExampleTab.open(context, UI);
  await connect(second);

  await second.sendLine('FROM THE SECOND TAB');
  await expect(first.locator('#received')).toContainText('FROM THE SECOND TAB   (another tab)');

  // Disconnect forgets the port for every tab: the browser's permission is the origin's. The other
  // tab cannot ask for a port on its own, so it says what happened and is disconnected too.
  await first.locator(UI.connect).click();
  await first.expectStatus('disconnected');
  await second.expectStatus('disconnected');
  await expect(second.locator('#received')).toContainText('The port was forgotten in another tab');
});

test('the built folder runs when opened as a file, with no web server, and shares the port', async ({
  context,
}) => {
  // The build takes half a minute: a self-contained OpenUI5 bundle, then scripts/finish-build.mjs,
  // which embeds what the framework would otherwise fetch - a page opened from a file may not.
  test.setTimeout(420_000);
  execFileSync('npm', ['run', 'build'], { cwd: HERE, stdio: 'ignore', shell: true });
  // The build takes the library's files out of webapp/ so the bundler leaves them alone; the server
  // the other tests use gets them back.
  execFileSync('npm', ['run', 'prestart'], { cwd: HERE, stdio: 'ignore', shell: true });
  const url = pathToFileURL(path.join(HERE, 'dist', 'index.html')).href;
  const fromFile = { ...UI, url };

  const first = await open(context, fromFile);
  await connect(first);
  const second = await ExampleTab.open(context, fromFile);
  await connect(second);

  // A page opened from a file may start no SharedWorker; the library coordinates the tabs over a
  // BroadcastChannel instead. What the operator sees is the same: one port, both tabs.
  await second.sendLine('HELLO FROM A FILE');
  for (const tab of [first, second]) {
    await expect(tab.locator('#received')).toContainText('HELLO FROM A FILE');
    await expect(tab.locator(UI.error)).toBeHidden();
  }

  // The build keeps six of the framework's modules and the two themes, and nothing else of its
  // 2 600 files (scripts/finish-build.mjs). So every part of the page is opened once: a module the
  // framework asks for and does not find shows here, as a request the browser refused.
  await toggleDisplayOption(first, 'optTimestamps');
  await first.locator(`${ID}sendMode`).click();
  await first.page.keyboard.press('Escape');
  await first.locator(`${ID}more`).click();
  await first.page.getByText('Send a file').click();
  await expect(first.locator(`${ID}fileDialog`)).toBeVisible();
  await first.locator(`${ID}fileClose`).click();
  await first.locator(`${ID}theme`).click();
  await expect(first.page.locator('html')).toHaveClass(
    /sap_horizon_dark|sapUiTheme-sap_horizon_dark/,
  );
  await first.locator(UI.connect).click();
  await first.expectStatus('disconnected');
  await first.locator(UI.connect).click();
  await first.locator(`${ID}baudRate-arrow`).click();
  await first.page.keyboard.press('Escape');
  await first.locator(`${ID}settingsCancel`).click();

  for (const tab of [first, second]) {
    // Nothing the framework asked for was refused: no text bundle, no locale data, no module.
    tab.expectQuiet();
  }
});
