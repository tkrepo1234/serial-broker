/**
 * The debugging surface, driven the way an operator drives it.
 *
 * The page is shipped in the package (ADR-0019) and is what someone reaches for when a device
 * does not behave, so what it offers has to be there in a real browser, not only in its markup.
 * Its unit tests read `debug/public/index.html` as text; these click it.
 *
 * The scenario is a configuration this page is not connected to: every way of stopping is offered
 * for it as well, so dropping a remembered entry does not mean connecting to it first. See ADR-0033
 * for what releasing does and does not forget, and ADR-0035 for why this suite looks the way it
 * does.
 */

import { expect, test, type Page } from '@playwright/test';

import { GRANTED_DEVICE, installStandIn } from './support/tab.js';

/** Where the built page lives on the test server, which serves `dist/` as the package ships it. */
const SURFACE = '/dist/debug/index.html';

/**
 * Opens the surface and waits until it has answered for this origin.
 *
 * By id rather than by label: the page offers _New configuration_ twice - in the header, and again
 * in the empty state it shows when this origin has no configurations at all - so the label alone
 * names two buttons in a browser that has never seen this page.
 */
async function openSurface(page: Page): Promise<void> {
  await page.goto(SURFACE);
  await expect(page.locator('#newButton')).toBeVisible();
}

/** Creates a configuration through the dialog, as the page's own buttons do. */
async function createConfiguration(page: Page, name: string): Promise<void> {
  await page.locator('#newButton').click();
  await page.locator('#name').fill(name);
  await page.locator('#setupDialog [data-part="submit"]').click();
}

test.describe('the debugging surface', () => {
  test('offers connecting, editing and disconnecting for the selected configuration', async ({
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const page = await context.newPage();
    await openSurface(page);
    await createConfiguration(page, 'Scale');

    // Whatever the configuration is doing, what can be done with it is visible rather than folded
    // into a menu. Connect is the exception: there is nothing to connect to while it runs here.
    const detail = page.locator('#detail');
    await expect(detail.locator('[data-part="edit"]')).toBeVisible();
    await expect(detail.locator('[data-part="disconnect"]')).toBeVisible();
    await expect(detail.locator('[data-part="connect"]')).toBeHidden();
  });

  test('forgets a configuration it is not connected to, without connecting first', async ({
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const page = await context.newPage();
    await openSurface(page);
    await createConfiguration(page, 'Scale');

    // Disconnect, forgetting nothing: the entry stays, which is the point of ADR-0033 - a
    // disconnect is not a deletion, and the operator can connect to it again.
    const detail = page.locator('#detail');
    await detail.locator('[data-part="disconnect"]').click();
    await page.locator('#forgetDialog [data-part="submit"]').click();
    await expect(page.locator('#configurationRows')).toContainText('Scale');
    await expect(detail.locator('[data-part="connect"]')).toBeVisible();

    // The case that needs no connection first: the page is not using it, and the entry is dropped
    // all the same. The dialog says as much before it is confirmed.
    await detail.locator('[data-part="disconnect"]').click();
    await expect(page.locator('#forgetDialog')).toContainText('This page is not using it');
    await page.locator('#forgetDialog [data-part="forget"]').check();
    await page.locator('#forgetDialog [data-part="submit"]').click();

    await expect(page.locator('#configurationRows')).not.toContainText('Scale');

    // Gone from the browser, not only from the list: a reload reads what is remembered afresh, so
    // an entry that survived it would be one this page had merely stopped showing.
    await page.reload();
    await expect(page.locator('#newButton')).toBeVisible();
    await expect(page.locator('#configurationRows')).not.toContainText('Scale');
  });
  test('sends hex bytes as typed and shows them as hex in the traffic (manual test plan, step 22)', async ({
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const page = await context.newPage();
    await openSurface(page);
    await createConfiguration(page, 'Scale');

    const detail = page.locator('#detail');
    // A new configuration takes its device from the port the operator chooses; the stand-in's
    // picker answers with the granted device.
    await detail.locator('[data-part="choose"]').click();
    await expect(detail.locator('[data-part="status"]')).toHaveText('Port open');
    await detail.locator('[data-section="traffic"]').click();
    await detail.locator('[data-part="mode"]').selectOption('hex');
    // Hex bytes are sent as they are: a line ending appended to them would be a fourth byte.
    await expect(detail.locator('[data-part="terminator"]')).toBeDisabled();
    await detail.locator('[data-part="payload"]').fill('02 FF 03');
    await detail.locator('[data-part="send"] button[type="submit"]').click();

    // 0xFF is no text in any encoding the page would guess, so both lines - what was sent and
    // what the stand-in, a loopback, sent back - show the bytes and not a replacement character.
    const traffic = detail.locator('[data-part="traffic"]');
    await expect(traffic.getByText('02 FF 03')).toHaveCount(2);
    await expect(traffic).not.toContainText('\uFFFD');
  });
});
