/**
 * The two message buses, and the worker that is of no use.
 *
 * `BroadcastChannel` is what a tab falls back to when the `SharedWorker` is unavailable or
 * unusable (ADR-0007, ADR-0024). Both paths exist because of browser behaviour, so both are
 * worth one run in a browser. See ADR-0035.
 */

import { expect, test } from '@playwright/test';

import {
  echoConfiguration,
  GRANTED_DEVICE,
  installStandIn,
  Tab,
  waitForPortHolder,
} from './support/tab.js';

test.describe('the BroadcastChannel transport', () => {
  test('shares one port across tabs without a worker', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const first = await Tab.open(context, { transport: 'broadcastchannel' });
    const second = await Tab.open(context, { transport: 'broadcastchannel' });
    const tabs = [first, second];

    for (const tab of tabs) {
      await tab.setup('Echo', echoConfiguration());
      await tab.waitForStatus('Echo', 'open');
    }
    await second.send('Echo', 'FALLBACK');
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', 'FALLBACK');
    }

    // Indistinguishable from the worker transport, which is what ADR-0007 promises.
    await waitForPortHolder(tabs);
    expect((await first.sends('Echo')).map((send) => send.origin)).toEqual(['remote']);
  });
});

test.describe('a worker script of another protocol version', () => {
  test('is reported as PROTOCOL_VERSION_MISMATCH, and the tabs go on without it', async ({
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const workerUrl = '/other-protocol-version/serial-broker.worker.js';
    const first = await Tab.open(context, { workerUrl });
    const second = await Tab.open(context, { workerUrl });
    const tabs = [first, second];

    for (const tab of tabs) {
      await tab.setup('Echo', echoConfiguration());
    }
    for (const tab of tabs) {
      await tab.waitForErrorCode('PROTOCOL_VERSION_MISMATCH');
    }

    // The worker answers `hello` and drops everything else, so the tabs would be cut off from
    // each other if they kept using it. They switch to the BroadcastChannel and share the port
    // as usual (ADR-0024).
    for (const tab of tabs) {
      const fallbacks = (await tab.logRecords()).filter(
        (record) => record.event === 'environment.transport-fallback',
      );
      expect(fallbacks.map((record) => record.fields['reason'])).toEqual([
        'worker-other-protocol-version',
      ]);
      await tab.waitForStatus('Echo', 'open');
    }
    await first.send('Echo', 'STILL-HERE');
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', 'STILL-HERE');
    }
    await waitForPortHolder(tabs);
  });
});
