import { describe, expect, it } from 'vitest';

import { ownerLockName } from '../../../src/protocol/version.js';
import { persistenceLockName } from '../../../src/storage/persistence-hold.js';
import { TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import { rememberedNames } from '../../harness/stored-configurations.js';

import {
  expectEveryTabStillWorks,
  IS_EXTREME,
  measured,
  MeteredHarness,
  SIZES,
  stateOf,
} from './support/extreme.js';

/**
 * Row 16 of the scenario matrix at a size that finds a leak of one object per cycle:
 * `test/integration/resource-lifecycle.test.ts` does five rounds, this does a thousand, in two
 * tabs that take turns holding the port.
 *
 * The footprint compared is that of the two tabs after one cycle, with nothing set up, so
 * anything a cycle leaves behind - a lock, a timer, a listener, a remembered entry - is a
 * difference.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)('setup and release churn (%s)', (transport) => {
  it(
    `leaves nothing behind after ${String(SIZES.cycles)} cycles in two tabs`,
    { timeout: 900_000 },
    async () => {
      const harness = new MeteredHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const first = harness.openTab();
      const second = harness.openTab();
      const clients = [first.client, second.client];
      // One cycle before measuring: what a tab keeps for its own life - its place on the bus, its
      // device listeners - appears with its first setup and is not what a cycle leaves behind.
      for (const tab of [first, second]) {
        await tab.client.setup('Reader', READER_OPTIONS);
      }
      await harness.settle();
      for (const tab of [first, second]) {
        await tab.client.release('Reader');
      }
      await harness.settle();
      let opens = 0;

      const { before, after } = await measured(
        harness,
        { name: 'setup and release churn', transport },
        clients,
        { cycles: SIZES.cycles, tabs: 2 },
        // Claims, releases and handovers: a fixed number per cycle, however many cycles came before.
        { sent: SIZES.cycles * 16, delivered: SIZES.cycles * 16 },
        async () => {
          for (let cycle = 0; cycle < SIZES.cycles; cycle += 1) {
            // The tab that sets up first holds the port; the other queues behind it, and takes it
            // over when the first releases - or, on every other cycle, leaves first itself.
            const [leader, follower] = cycle % 2 === 0 ? [first, second] : [second, first];
            await leader.client.setup('Reader', READER_OPTIONS);
            await follower.client.setup('Reader', READER_OPTIONS);
            await harness.settle();
            if (cycle % 4 < 2) {
              await leader.client.release('Reader');
              await harness.settle();
              await follower.client.release('Reader');
            } else {
              await follower.client.release('Reader');
              await harness.settle();
              await leader.client.release('Reader');
            }
            await harness.settle();
            opens = device.openCount;
          }
        },
      );

      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 2);
      expect(device.isOpen).toBe(false);
      expect(opens).toBeGreaterThanOrEqual(SIZES.cycles);
      expect(harness.locks.holdersOf(ownerLockName('Reader'))).toEqual([]);
      expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(0);
      expect(harness.locks.holdersOf(persistenceLockName('Reader'))).toEqual([]);
      expect(rememberedNames(harness.storage)).toEqual([]);
      expect(first.client.names()).toEqual([]);
      expect(second.client.names()).toEqual([]);

      // And one more setup works as the first did.
      await first.client.setup('Reader', READER_OPTIONS);
      await second.client.setup('Reader', READER_OPTIONS);
      await harness.advance(1_000);
      await expectEveryTabStillWorks(harness, [first, second], device, 'Reader');
    },
  );
});
