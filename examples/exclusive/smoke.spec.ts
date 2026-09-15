/**
 * Smoke test of the exclusive example, run through the repository root:
 *
 *     npm run build
 *     npm run test:examples -- examples/exclusive/smoke.spec.ts
 *
 * The root's Playwright configuration starts the example with `npm start` on the port in
 * example.json. The Web Serial stand-in (test/browser/stand-in/) replaces the device with a
 * granted loopback adapter: everything a page writes comes back on its read stream, and only one
 * page of the origin can hold it open, as in the browser.
 */

import { expect, test } from '@playwright/test';

import { ExampleTab, installLoopback, USUAL_IDS, type ExampleUi } from '../smoke-support.js';

const UI: ExampleUi = {
  ...USUAL_IDS,
  url: 'http://localhost:8153/',
  setUpAgain: '#setup',
};

/**
 * A page of the same origin that is not this example - another application, or a copy of this one
 * whose author changed `maxTabs` - and that runs "Cutter" with a limit of two. The test serves it
 * itself, at this URL, through `context.route()`.
 */
const OTHER_APPLICATION_URL = 'http://localhost:8153/other-application.html';

/**
 * The library as Vite's development server serves it to the example: the linked package lives
 * outside the example, so Vite serves its files under the `/@fs/` prefix, by absolute path. The
 * other application has to load the worker script from the very same URL as the example does - a
 * SharedWorker is identified by the URL of its script - and this is that URL.
 *
 * The path of this file's `file:` URL is `/C:/...` on Windows and `/home/...` elsewhere; Vite
 * takes both after the prefix.
 */
function servedByVite(fileInRepository: string): string {
  const { pathname } = new URL(`../../${fileInRepository}`, import.meta.url);
  return `/@fs${decodeURIComponent(pathname)}`;
}

const OTHER_APPLICATION_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Another application, maxTabs: 2</title></head>
  <body>
    <script type="module">
      import { SerialBroker } from '${servedByVite('dist/index.js')}';

      SerialBroker.configure({ workerUrl: '${servedByVite('dist/serial-broker.worker.js')}' });
      await SerialBroker.setup('Cutter', {
        device: { any: true },
        serial: { baudRate: 9600 },
        maxTabs: 2,
        remember: false,
      });
      SerialBroker.subscribe('Cutter', 'onStatusChange', (event) => {
        document.body.dataset.status = event.status;
      });
      document.body.dataset.status = SerialBroker.getStatus('Cutter').status;
    </script>
  </body>
</html>
`;

/** Every tab a test opened: the noise of any of them fails the test. */
const tabs: ExampleTab[] = [];

test.beforeEach(async ({ context }) => {
  tabs.length = 0;
  await installLoopback(context, true);
});

test.afterEach(() => {
  for (const tab of tabs) {
    tab.expectQuiet();
  }
});

async function openTab(context: Parameters<typeof ExampleTab.open>[0], url = UI.url) {
  const tab = await ExampleTab.open(context, { ...UI, url });
  tabs.push(tab);
  return tab;
}

test('one tab opens the granted device, sends a line and sees it echoed', async ({ context }) => {
  const tab = await openTab(context);

  // The device was granted on an "earlier visit", so no click is needed to reach `open`.
  await tab.expectOpenWithoutClick();
  await expect(tab.locator('#release')).toBeVisible();
  await expect(tab.locator('#error')).toBeHidden();

  await tab.sendLine('CUT 10');
});

test('a second tab is queued, and takes over when the first releases', async ({ context }) => {
  const first = await openTab(context);
  await first.expectStatus('open');

  const second = await openTab(context);
  await second.expectStatus('queued');
  await expect(second.locator('#status-explanation')).toContainText(
    'Another tab is using the device',
  );
  // Waiting is not an error, and it offers nothing to click but the way out.
  await expect(second.locator('#error')).toBeHidden();
  await expect(second.locator('#connect')).toBeHidden();
  await expect(second.locator('#send-button')).toBeDisabled();

  await first.locator('#release').click();
  await first.expectStatus('released');
  await expect(first.locator('#release')).toBeHidden();
  await expect(first.locator('#setup')).toBeVisible();

  await second.expectStatus('open');
  await second.sendLine('CUT 20');
  // The tab that released receives nothing any more.
  await expect(first.locator('#received')).not.toContainText('CUT 20');

  // Asking for the device again joins the queue behind the tab that took over.
  await first.locator('#setup').click();
  await first.expectStatus('queued');
});

test('a second tab takes over when the first closes', async ({ context }) => {
  const first = await openTab(context);
  await first.expectStatus('open');

  const second = await openTab(context);
  await second.expectStatus('queued');

  await first.page.close();

  await second.expectStatus('open');
  await second.sendLine('CUT 30');
});

test('a tab that finds the device run under another limit fails, and "Use the device again" starts over', async ({
  context,
}) => {
  await context.route(OTHER_APPLICATION_URL, (route) =>
    route.fulfill({ contentType: 'text/html', body: OTHER_APPLICATION_HTML }),
  );
  const other = await openTab(context, OTHER_APPLICATION_URL);
  await expect(other.locator('body')).toHaveAttribute('data-status', 'open');

  // The example's tab withdraws: the tab holding the port decides the limit (ADR-0025).
  const tab = await openTab(context);
  await tab.expectStatus('failed');
  await expect(tab.locator('#error')).toBeVisible();
  await expect(tab.locator('#error-code')).toHaveText('CONFIGURATION_CONFLICT');
  await expect(tab.locator('#error-recovering')).toBeHidden();
  await expect(tab.locator('#send-button')).toBeDisabled();
  // Both ways out are offered: give the device up, or start over.
  await expect(tab.locator('#release')).toBeVisible();
  await expect(tab.locator('#setup')).toBeVisible();

  // The other application goes away, but a withdrawn tab does not come back by itself ...
  await other.page.close();
  await tab.expectStatus('failed');

  // ... and `setup()` alone would do nothing for a name that is still set up. The button
  // releases the failed configuration first, and the new one reaches the device.
  await tab.locator('#setup').click();
  await tab.expectStatus('open');
  await expect(tab.locator('#error')).toBeHidden();
  await expect(tab.locator('#setup')).toBeHidden();
  await expect(tab.locator('#release')).toBeVisible();
  await tab.sendLine('CUT 40');
});
