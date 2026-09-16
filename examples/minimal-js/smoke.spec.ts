/**
 * Smoke test of the minimal JavaScript example, run through the repository root:
 *
 *     npm run test:examples -- examples/minimal-js/smoke.spec.ts
 *
 * The root configuration starts the example with its `npm start` on port 8159. The Web Serial
 * stand-in replaces the device with a loopback the origin has *not* been granted, so the page's
 * connect button is what opens the port - the one step of the integration that needs the user,
 * and the one this example exists to show.
 */
import { expect, test } from '@playwright/test';

import { ExampleTab, installLoopback, USUAL_IDS, type ExampleUi } from '../smoke-support.js';

const UI: ExampleUi = {
  ...USUAL_IDS,
  url: 'http://localhost:8159/',
  // The page keeps to the usual ids. It offers neither releasing nor an error code of its own -
  // it is the smallest page that works, and the TypeScript sibling is where those are shown - so
  // these two selectors are named for the shape of ExampleUi and never used.
  release: '#release',
  setUpAgain: '#restart',
};

test('connects from a click, echoes a line and stays quiet', async ({ context }) => {
  await installLoopback(context, false);
  const tab = await ExampleTab.open(context, UI);

  await tab.connectByClick();
  await expect(tab.locator('#send-button')).toBeEnabled();

  await tab.sendLine('PING');
  await expect(tab.locator('#send-input')).toHaveValue('');
  await expect(tab.locator('#error')).toBeEmpty();

  tab.expectQuiet();
});
