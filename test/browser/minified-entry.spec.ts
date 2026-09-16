/**
 * `dist/serial-broker.min.js`, loaded by a page without a bundler.
 *
 * The minified build is a separate published artefact with its own failure mode: a minifier that
 * renames something the worker script agrees on, or a build that points it at a worker of its
 * own, would split the tabs into groups that cannot see each other. Nothing but loading both
 * builds in one browser catches that. See ADR-0035.
 */

import { expect, test } from '@playwright/test';

import {
  echoConfiguration,
  GRANTED_DEVICE,
  installStandIn,
  Tab,
  waitForPortHolder,
} from './support/tab.js';

test.describe('the minified entry point', () => {
  test('shares the port with a tab running the readable build', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const minified = await Tab.open(context, { page: 'tab-min.html' });
    const readable = await Tab.open(context, { page: 'tab.html' });
    const tabs = [minified, readable];

    for (const tab of tabs) {
      await tab.setup('Echo', echoConfiguration());
      await tab.waitForStatus('Echo', 'open');
    }
    await minified.send('Echo', 'MINIFIED');
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', 'MINIFIED');
    }

    // One port for both builds: they agree on the protocol version, the lock names and the
    // worker script, which is what `serial-broker/min` promises.
    expect(await minified.protocolVersion()).toBe(await readable.protocolVersion());
    await waitForPortHolder(tabs);
    expect(minified.pageErrors).toEqual([]);
  });
});
