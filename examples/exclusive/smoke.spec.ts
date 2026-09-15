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

import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import { installWebSerialStandIn } from '../../test/browser/stand-in/web-serial-stand-in.js';

const APPLICATION_URL = 'http://localhost:8153/';

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

/** Uncaught errors and console warnings or errors of every page: any of them fails the test. */
const noise: string[] = [];

test.beforeEach(async ({ context }) => {
  noise.length = 0;
  // Before the first page: the stand-in must be there before the page's own scripts run.
  await context.addInitScript(installWebSerialStandIn, {
    devices: [{ id: 'loopback', granted: true }],
  });
});

test.afterEach(() => {
  expect(noise, 'the page wrote to the console or threw').toEqual([]);
});

async function openTab(context: BrowserContext, url = APPLICATION_URL): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => noise.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      noise.push(`console.${message.type()}: ${message.text()}`);
    }
  });
  await page.goto(url);
  return page;
}

async function sendLine(page: Page, line: string): Promise<void> {
  await page.locator('#send-input').fill(line);
  await page.locator('#send-button').click();
  await expect(page.locator('#received')).toContainText(line);
}

test('one tab opens the granted device, sends a line and sees it echoed', async ({ context }) => {
  const tab = await openTab(context);

  // The device was granted on an "earlier visit", so no click is needed to reach `open`.
  await expect(tab.locator('#status')).toHaveText('open');
  await expect(tab.locator('#connect')).toBeHidden();
  await expect(tab.locator('#release')).toBeVisible();
  await expect(tab.locator('#error')).toBeHidden();

  await sendLine(tab, 'CUT 10');
});

test('a second tab is queued, and takes over when the first releases', async ({ context }) => {
  const first = await openTab(context);
  await expect(first.locator('#status')).toHaveText('open');

  const second = await openTab(context);
  await expect(second.locator('#status')).toHaveText('queued');
  await expect(second.locator('#status-explanation')).toContainText(
    'Another tab is using the device',
  );
  // Waiting is not an error, and it offers nothing to click but the way out.
  await expect(second.locator('#error')).toBeHidden();
  await expect(second.locator('#connect')).toBeHidden();
  await expect(second.locator('#send-button')).toBeDisabled();

  await first.locator('#release').click();
  await expect(first.locator('#status')).toHaveText('released');
  await expect(first.locator('#release')).toBeHidden();
  await expect(first.locator('#setup')).toBeVisible();

  await expect(second.locator('#status')).toHaveText('open');
  await sendLine(second, 'CUT 20');
  // The tab that released receives nothing any more.
  await expect(first.locator('#received')).not.toContainText('CUT 20');

  // Asking for the device again joins the queue behind the tab that took over.
  await first.locator('#setup').click();
  await expect(first.locator('#status')).toHaveText('queued');
});

test('a second tab takes over when the first closes', async ({ context }) => {
  const first = await openTab(context);
  await expect(first.locator('#status')).toHaveText('open');

  const second = await openTab(context);
  await expect(second.locator('#status')).toHaveText('queued');

  await first.close();

  await expect(second.locator('#status')).toHaveText('open');
  await sendLine(second, 'CUT 30');
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
  await expect(tab.locator('#status')).toHaveText('failed');
  await expect(tab.locator('#error')).toBeVisible();
  await expect(tab.locator('#error-code')).toHaveText('CONFIGURATION_CONFLICT');
  await expect(tab.locator('#error-recovering')).toBeHidden();
  await expect(tab.locator('#send-button')).toBeDisabled();
  // Both ways out are offered: give the device up, or start over.
  await expect(tab.locator('#release')).toBeVisible();
  await expect(tab.locator('#setup')).toBeVisible();

  // The other application goes away, but a withdrawn tab does not come back by itself ...
  await other.close();
  await expect(tab.locator('#status')).toHaveText('failed');

  // ... and `setup()` alone would do nothing for a name that is still set up. The button
  // releases the failed configuration first, and the new one reaches the device.
  await tab.locator('#setup').click();
  await expect(tab.locator('#status')).toHaveText('open');
  await expect(tab.locator('#error')).toBeHidden();
  await expect(tab.locator('#setup')).toBeHidden();
  await expect(tab.locator('#release')).toBeVisible();
  await sendLine(tab, 'CUT 40');
});
