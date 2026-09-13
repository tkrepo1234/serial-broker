import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { BrowserHarness } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * A worker script that was not deployed, or is served from the wrong path (ADR-0007).
 *
 * The browser still creates the `SharedWorker` and reports the failure only afterwards - by which
 * time each tab has announced itself, attached, and one of them has claimed the port. These
 * scenarios check that the tabs then coordinate over `BroadcastChannel` as if they had started
 * there.
 */
describe('tabs whose worker script fails to load', () => {
  async function twoTabs(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    owner: ReturnType<BrowserHarness['openTab']>;
    other: ReturnType<BrowserHarness['openTab']>;
  }> {
    const harness = new BrowserHarness({ transport: 'sharedworker', workerScript: 'fails' });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const owner = harness.openTab();
    await owner.setup('CardReader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('CardReader', READER_OPTIONS);

    return { harness, device, owner, other };
  }

  it('share the port over BroadcastChannel once the failure is reported', async () => {
    const { harness, device, owner, other } = await twoTabs();

    harness.bus.failWorkerScripts();
    await harness.settle();

    device.emit('CARD:1234');
    await harness.settle();
    await other.client.send('CardReader', 'STATUS?');
    await harness.settle();

    expect(owner.receivedText('CardReader')).toBe('CARD:1234');
    expect(other.receivedText('CardReader')).toBe('CARD:1234');
    expect(device.writtenText()).toBe('STATUS?');
    expect(device.written).toHaveLength(1);
    expect(device.openCount).toBe(1);
    expect(owner.client.transportKind).toBe('broadcastchannel');
    expect(other.client.transportKind).toBe('broadcastchannel');
  });

  it('show a joining tab the status it asked for before the failure', async () => {
    const { harness, other } = await twoTabs();
    // The request went into a worker that never ran, so nothing has answered it yet.
    expect(other.client.getStatus('CardReader').status).not.toBe(SerialBrokerStatus.Open);

    harness.bus.failWorkerScripts();
    await harness.settle();

    expect(other.client.getStatus('CardReader').status).toBe(SerialBrokerStatus.Open);
  });

  it('write what was sent before the failure, exactly once', async () => {
    const { harness, device, other } = await twoTabs();

    const sent = other.client.send('CardReader', 'PING');
    harness.bus.failWorkerScripts();
    await sent;
    await harness.settle();

    expect(device.writtenText()).toBe('PING');
    expect(device.written).toHaveLength(1);
  });
});
