import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { BrowserHarness } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * A worker that dies while tabs are open: it crashed, was ended for memory, or was terminated from
 * `chrome://inspect` (ADR-0041).
 *
 * A port to a dead worker reports nothing in either direction, and tabs opened later start a new
 * worker that knows none of the tabs already open. The browser lets go of the lock the worker held
 * for its lifetime, and every open tab waiting on it connects to the new worker at once. No time
 * passes in these scenarios: nothing about noticing the loss is timed.
 */
describe('tabs whose worker dies', () => {
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
    await owner.setup('Reader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('Reader', READER_OPTIONS);
    return { harness, device, owner, other };
  }

  it('share the port again through a new worker, at once', async () => {
    const { harness, device, owner, other } = await twoTabs();

    harness.bus.crashWorker();
    await harness.settle();

    device.emit('AFTER');
    await harness.settle();
    await other.client.send('Reader', 'PING');
    await harness.settle();

    expect(other.receivedText('Reader')).toBe('AFTER');
    expect(device.writtenText()).toBe('PING');
    expect(harness.bus.workerHost.clientCount).toBe(2);
    expect(owner.client.transportKind).toBe('sharedworker');
    expect(other.client.transportKind).toBe('sharedworker');
  });

  it('each report the lost worker once', async () => {
    const { harness, owner, other } = await twoTabs();

    harness.bus.crashWorker();
    await harness.settle();
    await harness.busClock.advance(3_600_000);
    await harness.settle();

    for (const tab of [owner, other]) {
      expect(tab.recordFor('Reader').errors.map((event) => event.error.code)).toEqual([
        SerialBrokerErrorCode.BROKER_UNAVAILABLE,
      ]);
      // The tabs connect to a new worker on their own, so the application has nothing to act on.
      expect(tab.recordFor('Reader').errors.map((event) => event.error.isRetryable)).toEqual([
        true,
      ]);
    }
  });

  it('are joined by a tab opened after the crash', async () => {
    const { harness, device, other } = await twoTabs();

    // The new tab starts the new worker, which knows nothing of the tabs already open.
    harness.bus.crashWorker();
    const late = harness.openTab();
    await late.setup('Reader', READER_OPTIONS);
    await harness.settle();

    device.emit('TOGETHER');
    await harness.settle();

    expect(late.receivedText('Reader')).toBe('TOGETHER');
    expect(other.receivedText('Reader')).toBe('TOGETHER');
    expect(harness.bus.workerHost.clientCount).toBe(3);

    // It may have set up while the new worker knew no owner to ask for the status, and learns it
    // all the same: the owner restates it on reaching the new worker.
    expect(late.client.getStatus('Reader').status).toBe('open');
    const writing = late.client.send('Reader', 'LATE');
    await harness.settle();
    await expect(writing).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('LATE');
  });

  it('hand on a write that was lost with the dead worker, and write it once', async () => {
    const { harness, device, other } = await twoTabs();

    // Sent into the dead worker in the same task that ended it, before any tab could hear of it.
    harness.bus.crashWorker();
    const writing = other.client.send('Reader', 'LOST');
    await harness.settle();

    await expect(writing).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('LOST');
    expect(device.written).toHaveLength(1);
  });
});
