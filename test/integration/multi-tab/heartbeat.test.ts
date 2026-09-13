import { describe, expect, it } from 'vitest';

import {
  HEARTBEAT_INTERVAL_MS,
  SILENT_PARTICIPANT_TIMEOUT_MS,
  SWEEP_INTERVAL_MS,
} from '../../../src/protocol/heartbeat.js';
import { BrowserHarness } from '../../harness/browser-harness.js';

const READER = { vendorId: 0x1a86, productId: 0x7523 };
const OPTIONS = { device: READER, serial: { baudRate: 9600 } };

/**
 * Tabs that die without saying goodbye, as the worker experiences them (ADR-0021).
 *
 * A real worker is never told that a tab died. The harness now behaves the same way, so the only
 * thing that can make the worker forget a tab is that its heartbeats stop.
 */
describe('tabs on the SharedWorker', () => {
  async function twoTabs(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    owner: ReturnType<BrowserHarness['openTab']>;
    other: ReturnType<BrowserHarness['openTab']>;
  }> {
    const harness = new BrowserHarness({ transport: 'sharedworker' });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.setup('Reader', OPTIONS);
    const other = harness.openTab();
    await other.setup('Reader', OPTIONS);
    return { harness, device, owner, other };
  }

  it('are forgotten by the worker once a tab that died stops sending heartbeats', async () => {
    const { harness, other } = await twoTabs();
    expect(harness.bus.workerHost.clientCount).toBe(2);

    await other.kill();
    // Not yet: a quiet tab is not a dead one until the timeout has passed.
    await harness.busClock.advance(SILENT_PARTICIPANT_TIMEOUT_MS - SWEEP_INTERVAL_MS);
    expect(harness.bus.workerHost.clientCount).toBe(2);

    await harness.busClock.advance(2 * SWEEP_INTERVAL_MS);
    await harness.settle();
    expect(harness.bus.workerHost.clientCount).toBe(1);
  });

  it('are all kept while they are alive, however long they stay idle', async () => {
    const { harness, device, other } = await twoTabs();

    await harness.busClock.advance(10 * SILENT_PARTICIPANT_TIMEOUT_MS + HEARTBEAT_INTERVAL_MS);
    await harness.settle();
    device.emit('STILL HERE');
    await harness.settle();

    expect(harness.bus.workerHost.clientCount).toBe(2);
    expect(other.receivedText('Reader')).toBe('STILL HERE');
  });

  it('keep working after the owner died and its successor took over', async () => {
    const { harness, device, owner, other } = await twoTabs();

    await owner.kill();
    await harness.settle();
    await harness.busClock.advance(SILENT_PARTICIPANT_TIMEOUT_MS + SWEEP_INTERVAL_MS);
    await harness.settle();
    await other.client.send('Reader', 'PING');
    await harness.settle();

    expect(harness.bus.workerHost.clientCount).toBe(1);
    expect(device.writtenText()).toBe('PING');
  });
});
