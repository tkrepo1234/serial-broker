import { describe, expect, it } from 'vitest';

import { MAX_REMEMBERED_FINISHED_WRITES } from '../../../src/client/accepted-writes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import { outcomeOf } from '../../harness/outcomes.js';

import {
  countTraffic,
  expectEveryTabStillWorks,
  IS_EXTREME,
  measured,
  MeteredHarness,
  SIZES,
  stateOf,
} from './support/extreme.js';

const TABS = 10;

/** Writes issued together: a burst, far below what the port keeps waiting (ADR-0019). */
const BURST = 50;

/**
 * One tab holds the port for a long time and accepts every write the others issue.
 *
 * The tab holding the port remembers the writes it accepted in its term, so that a write handed
 * over twice is written once (ADR-0011). That record is what grows with the writes of a term, and
 * a term can last as long as the tab: it keeps every write in progress and a bounded number of
 * finished ones. It is not reported anywhere, so what is measured is its cost: the heap after
 * `SIZES.ownerWrites` writes, taken once the record is full, is the heap before them. A record
 * that kept every write would hold tens of thousands of keys, several MiB at the default size.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)('a long-lived owner (%s)', (transport) => {
  it(
    `accepts ${String(SIZES.ownerWrites)} writes in one term and keeps no record of them beyond its bound`,
    { timeout: 900_000 },
    async () => {
      const harness = new MeteredHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const tabs: VirtualTab[] = [];
      for (let index = 0; index < TABS; index += 1) {
        const tab = harness.openTab();
        await tab.client.setup('Reader', READER_OPTIONS);
        tabs.push(tab);
      }
      await harness.advance(1_000);
      const holder = harness.locks.holderOf(ownerLockName('Reader'));
      let written = 0;
      let failed = 0;

      /** Issues `count` writes in bursts from every tab in turn, and forgets what the device got. */
      async function issue(count: number, firstNumber: number): Promise<void> {
        for (let start = 0; start < count; start += BURST) {
          const outcomes: Promise<unknown>[] = [];
          for (let offset = 0; offset < BURST && start + offset < count; offset += 1) {
            const number = firstNumber + start + offset;
            const issuer = tabs[number % tabs.length];
            if (issuer === undefined) {
              throw new Error('No tab to issue the write');
            }
            const payload = new Uint8Array(4);
            new DataView(payload.buffer).setUint32(0, number);
            outcomes.push(outcomeOf(issuer.client.send('Reader', payload)));
          }
          await harness.settle();
          for (const outcome of await Promise.all(outcomes)) {
            if (outcome !== 'resolved') {
              failed += 1;
            }
          }
          written += device.written.length;
          device.written.length = 0;
        }
      }

      // Enough writes first to fill the record of finished writes, so that the heap before the
      // measured writes already holds everything a bounded record keeps.
      const warmUp = MAX_REMEMBERED_FINISHED_WRITES * 2;
      await issue(warmUp, 0);
      const counts = tabs.map((tab) => countTraffic(tab.client, 'Reader'));

      const { before, after } = await measured(
        harness,
        { name: 'a long-lived owner accepting writes', transport },
        tabs.map((tab) => tab.client),
        { tabs: TABS, writes: SIZES.ownerWrites, burst: BURST },
        // A few messages per write - request, start, result, report - each delivered at most
        // once to every tab; holding the port for longer makes none of them more expensive.
        { sent: SIZES.ownerWrites * 5, delivered: SIZES.ownerWrites * 5 * TABS },
        async () => {
          await issue(SIZES.ownerWrites, warmUp);
          await harness.advance(1_000);
        },
      );

      expect(failed).toBe(0);
      expect(written).toBe(warmUp + SIZES.ownerWrites);
      // One term throughout: the record measured is one record, never replaced by a new owner's.
      expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(holder);
      for (const [index, tab] of tabs.entries()) {
        expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
        expect(counts[index]).toMatchObject({ sent: SIZES.ownerWrites, errors: 0 });
      }
      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 1);
      await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
    },
  );
});
