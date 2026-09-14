import { describe, expect, it } from 'vitest';

import { brokerChannelName, PROTOCOL_VERSION } from '../../../src/protocol/version.js';
import { BrowserHarness } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../../harness/recording-logger.js';

/**
 * Tabs sharing a port while another script of the origin misbehaves on the bus (SECURITY.md).
 *
 * The script is not a tab: the test speaks for it, posting what any script of the origin can post.
 * What it cannot be stopped from - listening, and saying what a tab could say - is documented; these
 * tests hold the line on what it must not achieve.
 */

async function twoTabs(transport: 'sharedworker' | 'broadcastchannel'): Promise<{
  harness: BrowserHarness;
  device: ReturnType<BrowserHarness['serial']['addDevice']>;
  owner: ReturnType<BrowserHarness['openTab']>;
  other: ReturnType<BrowserHarness['openTab']>;
  records: ReturnType<typeof recordingLogger>['records'];
}> {
  const { logger, records } = recordingLogger();
  const harness = new BrowserHarness({ transport, logger });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const owner = harness.openTab();
  await owner.setup('Reader', READER_OPTIONS);
  const other = harness.openTab();
  await other.setup('Reader', READER_OPTIONS);
  return { harness, device, owner, other, records };
}

describe('a script on the SharedWorker that uses the identity of a tab', () => {
  it('hears nothing addressed to the tab holding the port by saying hello as it', async () => {
    const { harness, device, owner, other, records } = await twoTabs('sharedworker');
    const mallory = harness.bus.workerHost.connectForeign();

    // The identity is no secret - it is in every message the tab sends - but the secret the tab
    // showed the worker in its hello is (ADR-0028).
    mallory.post({
      v: PROTOCOL_VERSION,
      from: owner.client.clientId,
      to: 'all',
      type: 'hello',
      secret: 'guessed',
    });
    await harness.settle();
    const writing = other.client.send('Reader', 'PING');
    await harness.settle();

    expect(device.writtenText()).toBe('PING');
    await expect(writing).resolves.toBeUndefined();
    expect(mallory.received).toEqual([]);
    // The worker has no logger of its own, so the tabs write its records for it (ADR-0029).
    expect(fieldsOfEvent(records, 'worker.message-refused')).toEqual([
      expect.objectContaining({
        reason: 'secret-mismatch',
        claimedClientId: owner.client.clientId,
        reportedBy: owner.client.clientId,
      }),
      expect.objectContaining({ reason: 'secret-mismatch', reportedBy: other.client.clientId }),
    ]);
  });

  it('does not cut a tab off by saying goodbye in its name', async () => {
    const { harness, device, owner, other, records } = await twoTabs('sharedworker');
    const mallory = harness.bus.workerHost.connectForeign();

    mallory.post({
      v: PROTOCOL_VERSION,
      from: other.client.clientId,
      to: 'all',
      type: 'hello',
      secret: 'guessed',
    });
    mallory.post({ v: PROTOCOL_VERSION, from: other.client.clientId, to: 'all', type: 'goodbye' });
    await harness.settle();
    device.emit('STILL HERE');
    await harness.settle();

    expect(other.receivedText('Reader')).toBe('STILL HERE');
    // The hello is refused for its secret, so the port never holds the identity and the goodbye that
    // follows is a message before a hello. That a goodbye ends the port that sent it and not the
    // identity a tab still has ports for is held by test/unit/worker-ports.test.ts.
    expect(fieldsOfEvent(records, 'worker.message-refused')).toEqual([
      expect.objectContaining({ reason: 'secret-mismatch', reportedBy: owner.client.clientId }),
      expect.objectContaining({ reason: 'secret-mismatch', reportedBy: other.client.clientId }),
      expect.objectContaining({ reason: 'before-hello', reportedBy: owner.client.clientId }),
      expect.objectContaining({ reason: 'before-hello', reportedBy: other.client.clientId }),
    ]);
  });

  it('cannot speak for a tab from a port that said hello as something else', async () => {
    const { harness, device, owner, other, records } = await twoTabs('sharedworker');
    const mallory = harness.bus.workerHost.connectForeign();

    // An identity of its own, with a secret of its own: the port is served, and is held to the
    // identity it bound. Saying hello as the tab instead would end at the tab's secret (ADR-0028).
    mallory.post({
      v: PROTOCOL_VERSION,
      from: 'mallory',
      to: 'all',
      type: 'hello',
      secret: 'mallory-secret',
    });
    mallory.post({
      v: PROTOCOL_VERSION,
      from: other.client.clientId,
      to: 'all',
      type: 'detach',
      configName: 'Reader',
    });
    await harness.settle();
    device.emit('STILL HERE');
    await harness.settle();

    expect(other.receivedText('Reader')).toBe('STILL HERE');
    expect(fieldsOfEvent(records, 'worker.message-refused')).toEqual([
      expect.objectContaining({ reason: 'sender-mismatch', reportedBy: owner.client.clientId }),
      expect.objectContaining({ reason: 'sender-mismatch', reportedBy: other.client.clientId }),
    ]);
  });
});

describe('a script flooding the BroadcastChannel with messages beyond a limit', () => {
  it('is logged once in each tab, and the tabs go on sharing the port', async () => {
    const { harness, device, other, records } = await twoTabs('broadcastchannel');
    // Fake device data, from a sender whose identity is longer than any identifier may be.
    const oversized = {
      v: PROTOCOL_VERSION,
      from: 'm'.repeat(300),
      to: 'all',
      type: 'data-received',
      configName: 'Reader',
      payload: new Uint8Array([0x46, 0x41, 0x4b, 0x45]),
      text: 'FAKE',
      timestamp: 1,
    };

    for (let round = 0; round < 500; round += 1) {
      harness.bus.broadcastHub.injectForeign(brokerChannelName(), oversized);
    }
    await harness.settle();
    device.emit('REAL');
    await harness.settle();
    await other.client.send('Reader', 'PING');
    await harness.settle();

    expect(fieldsOfEvent(records, 'transport.limit-exceeded')).toHaveLength(2);
    expect(fieldsOfEvent(records, 'client.malformed-message')).toEqual([]);
    expect(other.receivedText('Reader')).toBe('REAL');
    expect(device.writtenText()).toBe('PING');
  });
});
