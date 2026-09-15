import { describe, expect, it } from 'vitest';

import { BrowserHarness } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/** A day, on the bus's clock: far longer than anything the worker could time. */
const DAY_MS = 24 * 3_600_000;

/**
 * Tabs that go away, as the worker experiences them (ADR-0041).
 *
 * A real worker is never told that a tab died, and the harness is not either. What tells it is the
 * Web Lock every tab holds for its lifetime, which the browser lets go of when the tab goes.
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
    await owner.setup('Reader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('Reader', READER_OPTIONS);
    return { harness, device, owner, other };
  }

  it.each(['killed', 'closed'] as const)(
    'are forgotten by the worker as soon as the browser lets go of the lock of a tab %s',
    async (ending) => {
      const { harness, other } = await twoTabs();
      const before = harness.bus.workerHost.clientCount;

      await (ending === 'killed' ? other.kill() : other.close());

      // No time passes: nothing is timed.
      expect(before).toBe(2);
      expect(harness.bus.workerHost.clientCount).toBe(1);
    },
  );

  it('are all kept while they are alive, however long they stay idle, with nothing sent', async () => {
    const { harness, device, other } = await twoTabs();
    const sentBefore = harness.bus.meter.sent;

    await harness.busClock.advance(7 * DAY_MS);
    await harness.settle();
    const sentWhileIdle = harness.bus.meter.sent - sentBefore;
    device.emit('STILL HERE');
    await harness.settle();

    expect(sentWhileIdle).toBe(0);
    expect(harness.bus.workerHost.clientCount).toBe(2);
    expect(other.receivedText('Reader')).toBe('STILL HERE');
    expect(other.recordFor('Reader').errors).toEqual([]);
  });
});
