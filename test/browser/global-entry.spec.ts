/**
 * `dist/serial-broker.global.js`, loaded by a page that has no modules at all.
 *
 * The classic script build is a published artefact with two failure modes of its own. A global
 * that is missing part of the surface leaves such a page unable to call the library:
 * `scripts/check-dist.mjs` compares the global with the ES module's exports after every build,
 * and the second test here checks the same thing in a browser, where `window` is real. A build
 * that looked for a worker of its own would split the tabs into groups that cannot see each
 * other, and nothing but loading both builds in one browser catches that - which is the first
 * test. See ADR-0043 and ADR-0035.
 */

import { expect, test } from '@playwright/test';

import {
  echoConfiguration,
  GRANTED_DEVICE,
  installStandIn,
  sharedWorkersOf,
  Tab,
  waitForPortHolder,
} from './support/tab.js';

/**
 * Where the classic build is told the broker script is.
 *
 * It has to be told: a classic script has no `import.meta.url`. The ES module tab resolves the
 * same file next to itself, so both tabs name one absolute URL and get one `SharedWorker`.
 */
const WORKER_URL = '/dist/serial-broker.worker.js';

/** The facade the global *is*: `SerialBroker.setup()` reads the same as it does in a module. */
const FACADE_CALLS = [
  'configure',
  'dispose',
  'exists',
  'getStatus',
  'names',
  'release',
  'releaseAll',
  'requestAccess',
  'restore',
  'send',
  'setup',
  'subscribe',
  'unsubscribe',
];

/** What `serial-broker` exports besides the facade. The global carries each as a property. */
const CARRIED_EXPORTS = [
  'isSerialBrokerError',
  'isSupported',
  'PROTOCOL_VERSION',
  'REMEDIATION',
  'SerialBrokerError',
  'SerialBrokerErrorCode',
  'SerialBrokerStatus',
];

test.describe('the classic script build', () => {
  test('shares the port with a tab running the ES module build', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const classic = await Tab.open(context, { page: 'tab-global.html', workerUrl: WORKER_URL });
    const esModule = await Tab.open(context, { page: 'tab.html' });
    const tabs = [classic, esModule];

    for (const tab of tabs) {
      await tab.setup('Echo', echoConfiguration());
      await tab.waitForStatus('Echo', 'open');
    }
    await classic.send('Echo', 'CLASSIC');
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', 'CLASSIC');
    }
    await esModule.send('Echo', 'MODULE');
    for (const tab of tabs) {
      await tab.waitForReceivedText('Echo', 'MODULE');
    }

    // One port and one broker for both builds: they agree on the protocol version, the lock names
    // and - the claim this build could most easily break - the worker script's URL.
    expect(await classic.protocolVersion()).toBe(await esModule.protocolVersion());
    await waitForPortHolder(tabs);
    const workers = await sharedWorkersOf(classic);
    expect(workers).toHaveLength(1);
    for (const tab of tabs) {
      expect(await tab.logEvents()).not.toContain('environment.transport-fallback');
      expect(tab.pageErrors).toEqual([]);
    }
  });

  test('puts the documented surface on one global, and only that one', async ({ context }) => {
    await installStandIn(context, GRANTED_DEVICE);
    const classic = await Tab.open(context, { page: 'tab-global.html', workerUrl: WORKER_URL });

    const surface = await classic.page.evaluate(() => {
      const api = (window as unknown as { SerialBroker: Record<string, unknown> }).SerialBroker;
      return {
        members: Object.keys(api),
        ourGlobals: Object.keys(window).filter((name) => name.startsWith('SerialBroker')),
        supported: (api['isSupported'] as () => boolean)(),
        protocolVersion: api['PROTOCOL_VERSION'],
        errorIsConstructor: typeof api['SerialBrokerError'],
        openStatus: (api['SerialBrokerStatus'] as Record<string, string>)['Open'],
        remediationForBroker: typeof (api['REMEDIATION'] as Record<string, string>)[
          'BROKER_UNAVAILABLE'
        ],
      };
    });

    expect(surface.members).toEqual(expect.arrayContaining([...FACADE_CALLS, ...CARRIED_EXPORTS]));
    // One name is the whole point: a page can say what it took from this library.
    expect(surface.ourGlobals).toEqual(['SerialBroker']);
    expect(surface.supported).toBe(true);
    expect(surface.protocolVersion).toBe(await classic.protocolVersion());
    expect(surface.errorIsConstructor).toBe('function');
    expect(surface.openStatus).toBe('open');
    expect(surface.remediationForBroker).toBe('string');
    expect(classic.pageErrors).toEqual([]);
  });

  test('never guesses the worker script, and names workerUrl when it has none', async ({
    context,
  }) => {
    await installStandIn(context, GRANTED_DEVICE);
    // The same page, with nothing passed to `configure()`: the documented mistake.
    const classic = await Tab.open(context, { page: 'tab-global.html' });

    await classic.setup('Echo', echoConfiguration());
    await classic.waitForLogEvent('environment.transport-fallback');

    // A guessed URL would be worse than none: it would resolve next to the page, differ between
    // pages, and give each of them a SharedWorker of its own (ADR-0006). So the tab says what is
    // missing and carries on over the BroadcastChannel, as the CommonJS build does.
    const fallbacks = (await classic.logRecords()).filter(
      (record) => record.event === 'environment.transport-fallback',
    );
    expect(String(fallbacks[0]?.fields['reason'])).toContain('workerUrl');
    await classic.waitForStatus('Echo', 'open');
    expect(classic.pageErrors).toEqual([]);
  });
});
