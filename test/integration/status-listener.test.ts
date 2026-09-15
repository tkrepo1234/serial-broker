import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerStatus } from '../../src/core/types.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/** A new `onStatusChange` listener is told the current status once (BACKLOG, P3). */

async function openTab() {
  const harness = new BrowserHarness();
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const tab = harness.openTab();
  await tab.client.setup('Reader', READER_OPTIONS);
  await harness.settle();
  return { harness, tab };
}

describe('a new status listener', () => {
  it('is told the current status once, after subscribe() has returned', async () => {
    const { harness, tab } = await openTab();
    const listener = vi.fn();

    tab.client.subscribe('Reader', 'onStatusChange', listener);
    expect(listener).not.toHaveBeenCalled();
    await harness.settle();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Reader',
        status: SerialBrokerStatus.Open,
        previousStatus: SerialBrokerStatus.Open,
      }),
    );
  });

  it('is not told when it unsubscribed before the status was delivered', async () => {
    const { harness, tab } = await openTab();
    const listener = vi.fn();

    const unsubscribe = tab.client.subscribe('Reader', 'onStatusChange', listener);
    unsubscribe();
    await harness.settle();

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a throwing listener from stopping the others', async () => {
    const { harness, tab } = await openTab();
    const good = vi.fn();

    tab.client.subscribe('Reader', 'onStatusChange', () => {
      throw new Error('broken listener');
    });
    tab.client.subscribe('Reader', 'onStatusChange', good);
    await harness.settle();

    expect(good).toHaveBeenCalledOnce();
  });
});
