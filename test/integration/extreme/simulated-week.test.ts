import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

import {
  countTraffic,
  expectEveryTabStillWorks,
  IS_EXTREME,
  measured,
  MeteredHarness,
  SIZES,
  stateOf,
} from './support/extreme.js';

const HOUR_MS = 3_600_000;

/**
 * Tabs left open for a simulated week, mostly idle: one chunk and one write an hour to show the port
 * is still shared.
 *
 * Who is still there is told by Web Locks, not by messages (ADR-0041), so an idle week costs the bus
 * nothing on either transport - which the numbers show.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)('a simulated week (%s)', (transport) => {
  it(
    `keeps ${String(SIZES.longLivedTabs)} tabs sharing the port through ${String(SIZES.days)} idle days`,
    { timeout: 900_000 },
    async () => {
      const harness = new MeteredHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const tabs: VirtualTab[] = [];
      for (let index = 0; index < SIZES.longLivedTabs; index += 1) {
        const tab = harness.openTab();
        await tab.client.setup('Reader', READER_OPTIONS);
        tabs.push(tab);
      }
      await harness.advance(10_000);
      const counts = tabs.map((tab) => countTraffic(tab.client, 'Reader'));
      const hours = SIZES.days * 24;

      const { before, after } = await measured(
        harness,
        { name: 'a simulated week', transport },
        tabs.map((tab) => tab.client),
        { tabs: SIZES.longLivedTabs, days: SIZES.days },
        // The hourly chunk and write are a few messages each, to every tab; nothing else crosses.
        { sent: hours * 6, delivered: hours * 6 * SIZES.longLivedTabs },
        async () => {
          for (let hour = 0; hour < hours; hour += 1) {
            await harness.busClock.advance(HOUR_MS);
            await harness.advance(HOUR_MS);
            device.emit(`hour ${String(hour)};`);
            await harness.settle();
            await tabs[hour % tabs.length]?.client.send('Reader', `hour ${String(hour)};`);
          }
          await harness.advance(1_000);
        },
      );

      for (const [index, tab] of tabs.entries()) {
        expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
        expect(counts[index]).toMatchObject({ received: hours, sent: hours, errors: 0 });
      }
      expect(device.written).toHaveLength(hours);
      expect(device.openCount).toBe(1);
      if (transport === 'sharedworker') {
        // The worker forgot nobody.
        expect(harness.bus.workerHost.clientCount).toBe(SIZES.longLivedTabs);
      }
      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 2);
      await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
    },
  );
});
