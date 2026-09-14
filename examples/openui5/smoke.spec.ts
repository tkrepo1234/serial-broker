/**
 * The OpenUI5 example, driven the way a user drives it: the page loads, _Connect_ is clicked, the
 * port opens, a line is sent and the loopback device echoes it into the traffic list.
 *
 * Run through the repository root, which starts the example on its own port first
 * (examples/README.md):
 *
 * ```sh
 * npm run test:examples -- examples/openui5/smoke.spec.ts
 * ```
 *
 * The Web Serial stand-in replaces the device (test/browser/stand-in/). Its device is deliberately
 * *not* granted beforehand, so that the connect path of the application is what is tested: a
 * granted device would open with no click at all, and `requestPort()` - the stand-in's as much as
 * the browser's - needs the transient activation of a real click.
 *
 * UI5 renders asynchronously and after the page's `load` event, so nothing is looked for by
 * position: every control has a fixed id, listed in README.md, and every expectation waits for it.
 */

import { readFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { installWebSerialStandIn } from '../../test/browser/stand-in/web-serial-stand-in.js';

/** The manifest the root reads, so the port lives in one place. */
const manifest = JSON.parse(readFileSync(new URL('./example.json', import.meta.url), 'utf8')) as {
  readonly port: number;
  readonly readyPath: string;
};

/** The DOM ids README.md documents: `<container id>-<component id>---<view id>--<control id>`. */
const ID_PREFIX = 'container-serialbroker---app--';

function control(page: Page, id: string): Locator {
  return page.locator(`#${ID_PREFIX}${id}`);
}

test.describe('the OpenUI5 example', () => {
  test('connects on Connect, sends a line and sees the echo', async ({ context, page }) => {
    await context.addInitScript(installWebSerialStandIn, {
      devices: [{ id: 'loopback', granted: false }],
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    await page.goto(`http://localhost:${String(manifest.port)}${manifest.readyPath}`);

    // No granted port: the model stops at `awaiting-permission`, and the application offers
    // Connect. The sap.m.Input puts its id on a wrapper; the element that takes keystrokes is the
    // `-inner` one.
    const status = control(page, 'statusIndicator-text');
    const connect = control(page, 'connectButton');
    const sendInput = control(page, 'sendInput-inner');
    const sendButton = control(page, 'sendButton');
    const traffic = control(page, 'receivedList');
    const counters = control(page, 'countersText');

    await expect(status).toHaveText(/Waiting for permission/u);
    await expect(sendButton).toBeDisabled();

    // The one gesture: a real click, so the stand-in's requestPort() sees transient activation
    // exactly as the browser's would.
    await connect.click();
    await expect(status).toHaveText(/^Open/u);
    await expect(sendButton).toBeEnabled();

    // "Append CR LF" is on by default, so the device receives `PING\r\n` and echoes it. The
    // traffic list shows the send (trailing newline stripped) and, once the echo arrives, the
    // received line; the counters prove the same six bytes went out and came back.
    await sendInput.fill('PING');
    await sendButton.click();
    await expect(traffic.locator('li').filter({ hasText: 'PING' })).toHaveCount(2);
    await expect(counters).toHaveText('6 bytes received, 6 bytes sent');
    await expect(sendInput).toHaveValue('');

    // The second configuration filters for a CH340 the stand-in does not offer, so it stays
    // waiting - and does so without an error strip.
    await expect(control(page, 'printerStatus-text')).toHaveText(/Waiting for permission/u);
    await expect(control(page, 'errorStrip')).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});
