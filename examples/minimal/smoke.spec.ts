/**
 * Smoke test of the minimal example, run through the repository root:
 *
 *     npm run test:examples -- examples/minimal/smoke.spec.ts
 *
 * The root configuration starts the example with its `npm start` on port 8151. The Web Serial
 * stand-in replaces the device with a loopback that the origin was granted on an earlier visit,
 * so the page connects on load with no click, and everything sent comes back.
 */
import { expect, test } from '@playwright/test';

import { ExampleTab, installLoopback, USUAL_IDS, type ExampleUi } from '../smoke-support.js';

const UI: ExampleUi = {
  ...USUAL_IDS,
  url: 'http://localhost:8151/',
  release: '#release',
  setUpAgain: '#restart',
};

test('connects on load, echoes a line, and survives the device being unplugged', async ({
  context,
}) => {
  await installLoopback(context, true);
  const tab = await ExampleTab.open(context, UI);

  await tab.expectOpenWithoutClick();
  await expect(tab.locator('#send-button')).toBeEnabled();
  await tab.sendLine('PING');
  await expect(tab.locator('#send-input')).toHaveValue('');
  await expect(tab.locator('#error')).toBeHidden();

  await tab.recoverFromUnplug(async () => {
    await expect(tab.locator('#error')).toBeVisible();
  });
  await expect(tab.locator('#send-button')).toBeEnabled();

  tab.expectQuiet();
});
