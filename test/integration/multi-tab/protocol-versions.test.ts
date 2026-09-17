import { describe, expect, it } from 'vitest';

import { SerialBrokerClient } from '../../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import type { ErrorEvent } from '../../../src/core/types.js';
import {
  ANNOUNCEMENT_CHANNEL_NAME,
  versionAnnouncement,
} from '../../../src/protocol/announcement.js';
import { PROTOCOL_VERSION } from '../../../src/protocol/version.js';
import { BrowserHarness, TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER_OPTIONS } from '../../harness/devices.js';

/**
 * Tabs on different protocol versions share no lock, worker or bus, and learn of each other only
 * through the version announcement (ADR-0007).
 */

/**
 * A tab of another build, on the announcement channel.
 *
 * It records what it hears and posts only what the test tells it to. A real tab answers in a later
 * task, after the application has subscribed to the configuration it just set up; the fake channel
 * delivers sooner than that, so the test posts the answer itself once `setup()` has returned.
 */
function tabOfAnotherBuild(harness: BrowserHarness): {
  heard: unknown[];
  post: (message: unknown) => void;
} {
  const heard: unknown[] = [];
  const channel = harness.bus.broadcastHub.create(ANNOUNCEMENT_CHANNEL_NAME, 'another-build');
  channel.addEventListener('message', (event) => {
    heard.push(event.data);
  });
  return {
    heard,
    post: (message) => {
      channel.postMessage(message);
    },
  };
}

function mismatches(tab: VirtualTab): ErrorEvent[] {
  return tab
    .recordFor('Reader')
    .errors.filter((event) => event.error.code === SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH);
}

describe.each(TRANSPORT_MODES)('tabs on different protocol versions (%s)', (transport) => {
  it('report a tab that announces another version once, and answer it every time', async () => {
    const harness = new BrowserHarness({ transport });
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const other = tabOfAnotherBuild(harness);

    other.post(versionAnnouncement(PROTOCOL_VERSION + 1, false));
    other.post(versionAnnouncement(PROTOCOL_VERSION + 1, false));
    await harness.settle();

    expect(mismatches(tab).map((event) => event.error.context)).toEqual([
      { theirVersion: PROTOCOL_VERSION + 1 },
    ]);
    // A tab left open across a deployment that changed the protocol: only a reload joins them.
    expect(mismatches(tab)[0]?.error.remediation).toContain('reload every tab');
    // Answered each time: a tab opened later has to learn of this one too.
    expect(other.heard).toEqual([
      versionAnnouncement(PROTOCOL_VERSION, true),
      versionAnnouncement(PROTOCOL_VERSION, true),
    ]);
  });

  it('learn of a tab on another version that was open before them', async () => {
    const harness = new BrowserHarness({ transport });
    const other = tabOfAnotherBuild(harness);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // The new tab announced itself, and the tab already open answers, as its library would.
    expect(other.heard).toEqual([versionAnnouncement(PROTOCOL_VERSION, false)]);
    other.post(versionAnnouncement(PROTOCOL_VERSION + 1, true));
    await harness.settle();

    expect(mismatches(tab).map((event) => event.error.context)).toEqual([
      { theirVersion: PROTOCOL_VERSION + 1 },
    ]);
  });

  it('never answer a reply, so two versions cannot keep each other talking', async () => {
    const harness = new BrowserHarness({ transport });
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const other = tabOfAnotherBuild(harness);

    other.post(versionAnnouncement(PROTOCOL_VERSION + 1, true));
    await harness.settle();

    expect(mismatches(tab)).toHaveLength(1);
    expect(other.heard).toEqual([]);
  });

  it('tell the applications of tabs on the same version nothing', async () => {
    const harness = new BrowserHarness({ transport });
    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    const second = harness.openTab();
    await second.setup('Reader', READER_OPTIONS);
    await harness.settle();

    expect(mismatches(first)).toEqual([]);
    expect(mismatches(second)).toEqual([]);
  });

  it('ignore anything else posted on the channel', async () => {
    const harness = new BrowserHarness({ transport });
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const other = tabOfAnotherBuild(harness);

    other.post('hello');
    other.post(null);
    other.post({ ...versionAnnouncement(PROTOCOL_VERSION + 1, false), protocolVersion: '5' });
    other.post({ type: 'serial-broker/protocol-version', protocolVersion: PROTOCOL_VERSION + 1 });
    await harness.settle();

    expect(tab.recordFor('Reader').errors).toEqual([]);
    expect(other.heard).toEqual([]);
  });

  it('stop answering once closed', async () => {
    const harness = new BrowserHarness({ transport });
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const other = tabOfAnotherBuild(harness);

    await tab.close();
    other.post(versionAnnouncement(PROTOCOL_VERSION + 1, false));
    await harness.settle();

    expect(other.heard).toEqual([]);
  });
});

describe('a platform without BroadcastChannel', () => {
  it('still sets configurations up, without detecting other versions', async () => {
    const harness = new BrowserHarness();
    const client = new SerialBrokerClient({
      ...harness.createEnvironment('bare'),
      createBroadcastChannel: undefined,
    });

    await expect(client.setup('Reader', READER_OPTIONS)).resolves.toBeUndefined();
    await client.dispose();
  });
});
