import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../src/core/types.js';
import { ownerLockName } from '../../src/protocol/version.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { connectedTab, READER, READER_OPTIONS, readerHarness } from '../harness/devices.js';
import { rememberedNames } from '../harness/stored-configurations.js';

/**
 * Row 16 of the scenario matrix: rapid setup/release churn leaks nothing.
 *
 * A library that holds a device is judged by what it lets go of. A leaked Web Lock makes a
 * configuration permanently unownable; a leaked timer keeps a dead connection retrying; a
 * leaked listener delivers events to an application that released the configuration and is no
 * longer expecting them. None of these show up in a functional test - they only show up after
 * an application has been running for a day.
 */
describe('resource lifecycle', () => {
  it('leaves nothing behind when churn happens in several tabs at once', async () => {
    const { harness, device } = readerHarness();
    const tabs = [harness.openTab(), harness.openTab(), harness.openTab()];

    for (let round = 0; round < 5; round += 1) {
      for (const tab of tabs) {
        await tab.client.setup('Reader', READER_OPTIONS);
      }
      await harness.settle();
      for (const tab of tabs) {
        await tab.client.release('Reader');
      }
      await harness.settle();
    }

    // Every tab queued for the lock on every round. A single missed abort would show up here
    // as a queue that never empties.
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(0);
    expect(harness.clock.pendingTimerCount).toBe(0);
    expect(device.isOpen).toBe(false);
  });

  it('stops delivering to listeners of a released configuration', async () => {
    const { harness, device } = readerHarness();
    const tab = harness.openTab();

    await tab.setup('Reader', READER_OPTIONS);
    const received: unknown[] = [];
    tab.client.subscribe('Reader', 'onReceive', (event) => received.push(event));

    await tab.client.release('Reader');
    await tab.client.setup('Reader', READER_OPTIONS);
    await harness.settle();
    const fresh: unknown[] = [];
    tab.client.subscribe('Reader', 'onReceive', (event) => fresh.push(event));
    device.emit('after the churn');
    await harness.settle();

    // The listener belonged to the released configuration. A fresh setup is a fresh
    // configuration, and the old subscription must not survive into it - while one registered on
    // the fresh configuration hears the chunk.
    expect(fresh).toHaveLength(1);
    expect(received).toHaveLength(0);
  });

  it('cleans up after a configuration that never connected', async () => {
    const harness = new BrowserHarness();
    // Present but never granted: the configuration reaches awaiting-permission and stops.
    harness.serial.addDevice(READER.vendorId, READER.productId);
    const tab = harness.openTab();

    for (let round = 0; round < 5; round += 1) {
      await tab.client.setup('Reader', READER_OPTIONS);
      await harness.settle();
      await tab.client.release('Reader');
      await harness.settle();
    }

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('cleans up after a configuration that was reconnecting when it was released', async () => {
    const { harness, device } = readerHarness();
    device.faults.failOpenWith = 'NetworkError';
    const tab = harness.openTab();

    await tab.setup('Reader', READER_OPTIONS);
    await harness.advance(1_000);
    expect(harness.clock.pendingTimerCount).toBeGreaterThan(0);

    await tab.client.release('Reader');
    await harness.settle();

    // The pending backoff timer has to be cancelled, or a released configuration keeps
    // reopening a port nobody asked for.
    expect(harness.clock.pendingTimerCount).toBe(0);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
  });

  it('releases everything when several configurations are disposed together', async () => {
    const { harness } = readerHarness();
    harness.serial.grant(harness.serial.addDevice(0x0403, 0x6001));
    const tab = harness.openTab();

    await tab.client.setup('Reader', READER_OPTIONS);
    await tab.client.setup('Scale', {
      device: { vendorId: 0x0403, productId: 0x6001 },
      serial: { baudRate: 19_200 },
    });
    await harness.settle();

    await tab.client.dispose();
    await harness.settle();

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    expect(harness.locks.holderOf(ownerLockName('Scale'))).toBeUndefined();
    expect(harness.clock.pendingTimerCount).toBe(0);
  });
});

describe('releasing a configuration', () => {
  it('reports released as its last status', async () => {
    const { tab } = await connectedTab();

    await tab.client.release('Reader');

    expect(tab.statusTrail('Reader').at(-1)).toBe(SerialBrokerStatus.Released);
  });

  it('keeps remembering a configuration set up again while the port was still closing', async () => {
    const { harness, tab } = await connectedTab();

    const releasing = tab.client.release('Reader');
    await tab.client.setup('Reader', READER_OPTIONS);
    await releasing;
    await harness.settle();

    expect(rememberedNames(harness.storage)).toEqual(['Reader']);
  });
});
