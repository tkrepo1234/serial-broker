/**
 * The no-bundler example, driven in a real browser with the Web Serial stand-in in place of a
 * device. Started and run through the repository root: `npm run test:examples --
 * examples/no-bundler/smoke.spec.ts`. See examples/README.md for the contract.
 */

import { expect, test, type Page } from '@playwright/test';

import { ExampleTab, installLoopback, USUAL_IDS, type ExampleUi } from '../smoke-support.js';

const ORIGIN = 'http://localhost:8154';
/** What app.js configures: the worker script next to the library, on the page's own origin. */
const WORKER_URL = `${ORIGIN}/serial-broker/serial-broker.worker.js`;

const UI: ExampleUi = {
  ...USUAL_IDS,
  url: `${ORIGIN}/`,
  sendButton: '#send',
  release: '#release',
  setUpAgain: '#retry',
};

/**
 * The scripts of the shared workers Chromium hosts for this page's browser context.
 *
 * What no page can observe and no network listener of Playwright reports: whether the library
 * runs on a `SharedWorker` at all, and from which script. A worker whose script fails to load is
 * silently replaced by a `BroadcastChannel` under `transport: 'auto'`, and the page keeps working
 * - which is the point of the fallback, and the reason a test has to look at the browser's own
 * list of workers, the way `chrome://inspect/#workers` does.
 */
async function sharedWorkerUrlsOf(page: Page): Promise<readonly string[]> {
  const context = page.context();
  const browser = context.browser();
  if (browser === null) {
    throw new Error('The browser is not available for a CDP session; this needs Chromium.');
  }
  const pageSession = await context.newCDPSession(page);
  const browserSession = await browser.newBrowserCDPSession();
  try {
    const { targetInfo } = await pageSession.send('Target.getTargetInfo');
    const { targetInfos } = await browserSession.send('Target.getTargets');
    return targetInfos
      .filter(
        (info) =>
          info.type === 'shared_worker' && info.browserContextId === targetInfo.browserContextId,
      )
      .map((info) => info.url);
  } finally {
    await pageSession.detach();
    await browserSession.detach();
  }
}

test('connects to a granted device, sends a line and sees it echoed', async ({ context }) => {
  // The device was granted on an earlier visit, so the page opens it with no click: that is the
  // normal case in production, and `?stand-in` is not needed - the stand-in comes from the test.
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);

  await tab.expectOpenWithoutClick();
  await expect(tab.locator('#error')).toBeHidden();

  // The loopback device echoes what is written, line ending included.
  await tab.sendLine('HELLO FROM THE PAGE');
  await expect(tab.locator('#sent')).toContainText('this tab');

  // The worker script is served from this origin at the configured URL, and the library runs on
  // it. Were the file missing - a wrong prefix in serve.mjs, a renamed file in a later dist/ - the
  // library would have fallen back to a BroadcastChannel and everything above would still pass.
  expect(await sharedWorkerUrlsOf(tab.page)).toEqual([WORKER_URL]);
  // The fallback, like every other warning, would have opened the page's library log.
  await expect(tab.locator('#log-section')).toBeHidden();

  // The page and the library are quiet: nothing uncaught, nothing on the console.
  tab.expectQuiet();
});
