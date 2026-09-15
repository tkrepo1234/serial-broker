import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

import {
  expectEveryTabStillWorks,
  IS_EXTREME,
  measured,
  MeteredHarness,
  outcomeOf,
  SIZES,
  stateOf,
} from './support/extreme.js';

/** How a write ended, as kept per write. `0` is a write that never settled. */
const RESOLVED = 1;
const OWNER_LOST = 2;
const OTHER = 3;
/** Issued by the tab that was killed with it outstanding: its promise died with the tab. */
const DIED_WITH_TAB = 4;
const UNSETTLED = Symbol('unsettled');

/**
 * Thousands of writes from many tabs while the tab holding the port keeps crashing.
 *
 * The one promise that matters here is ADR-0013's: a write reaches the device at most once,
 * whatever happens to the tab writing it. It is checked from the device's side - every payload
 * carries its number, and the device's record of what it received is compared with what each
 * `send()` reported - not from the library's.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)(
  'writes under owner crashes (%s)',
  (transport) => {
    it(
      `writes ${String(SIZES.writes)} payloads from ${String(SIZES.writers)} tabs at most once each, with the owner crashing every ${String(SIZES.writesPerCrash)} writes`,
      { timeout: 900_000 },
      async () => {
        const harness = new MeteredHarness({ transport });
        const device = harness.serial.addDevice(READER.vendorId, READER.productId);
        harness.serial.grant(device);
        const tabs: VirtualTab[] = [];
        for (let index = 0; index < SIZES.writers; index += 1) {
          const tab = harness.openTab();
          await tab.client.setup('Reader', READER_OPTIONS);
          tabs.push(tab);
        }
        await harness.advance(1_000);
        const outcomes = new Map<number, Promise<unknown>>();
        // Typed arrays rather than maps: what the scenario keeps about forty thousand writes must
        // not be what the footprint measures.
        /** How each write ended, by its number: {@link RESOLVED}, {@link OWNER_LOST} or {@link OTHER}. */
        const settled = new Uint8Array(SIZES.writes);
        /** How often the device received each write, by its number. */
        const timesWritten = new Uint8Array(SIZES.writes);
        const otherCodes = new Set<string>();
        /** Who issued each write of the current batch: the writes a killed tab takes with it. */
        const issuerOf = new Map<number, VirtualTab>();
        let crashes = 0;

        const { before, after } = await measured(
          harness,
          { name: 'writes under owner crashes', transport },
          // The tabs alive at the end are other tabs than at the start; what is compared is what a
          // set of this many tabs costs.
          () => tabs.map((tab) => tab.client),
          {
            writes: SIZES.writes,
            writers: SIZES.writers,
            writesPerCrash: SIZES.writesPerCrash,
          },
          // A few messages per write, each delivered to every tab - handovers and the writes they
          // hand on again included. The crashes may not multiply them.
          {
            sent: SIZES.writes * 8,
            delivered: SIZES.writes * 8 * SIZES.writers,
          },
          async () => {
            for (let index = 0; index < SIZES.writes; index += 1) {
              if (index % SIZES.writesPerCrash === 0) {
                // The device takes nothing for the whole batch, so that the batch is at the port -
                // the first write begun, the rest queued behind it - when the owner dies.
                device.pauseWrites();
                issuerOf.clear();
              }
              // The oldest tab holds the port, so the batch begins with the next one's write and
              // ends with the owner's own.
              const issuer = tabs[(index + 1) % tabs.length];
              if (issuer === undefined) {
                throw new Error('No tab to issue the write');
              }
              const payload = new Uint8Array(4);
              new DataView(payload.buffer).setUint32(0, index);
              outcomes.set(index, outcomeOf(issuer.client.send('Reader', payload)));
              issuerOf.set(index, issuer);
              if (index % SIZES.writesPerCrash === 0) {
                // The batch's first write reaches the device before the rest: it is the one that
                // has begun when the owner dies, and it is another tab's.
                await harness.settle();
              }

              if ((index + 1) % SIZES.writesPerCrash === 0) {
                await harness.settle();
                const holder = harness.locks.holderOf(ownerLockName('Reader'));
                const owner = tabs.findIndex((tab) => tab.id === holder);
                if (owner < 0) {
                  throw new Error(`No live tab holds the port (holder: ${String(holder)})`);
                }
                // The owner dies now, with no goodbye, and the device takes writes again. Its own
                // outstanding writes die with it: in a browser nobody is left to settle them, and
                // the harness cannot stop its code from settling them anyway, so they are set aside.
                const [killed] = tabs.splice(owner, 1);
                for (const [issued, by] of issuerOf) {
                  if (by === killed) {
                    settled[issued] = DIED_WITH_TAB;
                    outcomes.delete(issued);
                  }
                }
                await killed?.kill();
                crashes += 1;
                device.resumeWrites();
                const replacement = harness.openTab();
                await replacement.client.setup('Reader', READER_OPTIONS);
                tabs.push(replacement);
                await harness.advance(1_000);
              }
            }
            // Longer than any write deadline, so every outcome is in; the worker forgot the tabs that
            // died when the browser let go of their locks (ADR-0041).
            await harness.advance(10_000);
            await harness.settle();
            // Reduced to numbers before the footprint is taken: ten thousand settled promises and
            // their errors are the scenario's to keep, not the library's.
            for (const [index, outcome] of outcomes) {
              // Raced against a settled value rather than awaited: a write that never settled is a
              // finding to report, not a reason to hang until the timeout.
              const result = await Promise.race([outcome, Promise.resolve(UNSETTLED)]);
              const code = (result as { code?: unknown }).code;
              if (result === UNSETTLED) {
                settled[index] = 0;
              } else if (result === 'resolved') {
                settled[index] = RESOLVED;
              } else if (code === SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE) {
                settled[index] = OWNER_LOST;
              } else {
                settled[index] = OTHER;
                otherCodes.add(String(code));
              }
            }
            outcomes.clear();
            for (const chunk of device.written) {
              const index = new DataView(
                chunk.buffer,
                chunk.byteOffset,
                chunk.byteLength,
              ).getUint32(0);
              timesWritten[index] = (timesWritten[index] ?? 0) + 1;
            }
            device.written.length = 0;
          },
        );

        const byOutcome = {
          resolved: 0,
          ownerLost: 0,
          diedWithTab: 0,
          other: 0,
          unsettled: 0,
          reachedDevice: 0,
        };
        for (let index = 0; index < SIZES.writes; index += 1) {
          const written = timesWritten[index] ?? 0;
          byOutcome.reachedDevice += written > 0 ? 1 : 0;
          // Nothing twice, whatever the outcome.
          expect(written, `write ${String(index)}`).toBeLessThanOrEqual(1);
          switch (settled[index]) {
            case RESOLVED:
              byOutcome.resolved += 1;
              // A write that resolved reached the device: exactly once.
              expect(written, `write ${String(index)} resolved`).toBe(1);
              break;
            case OWNER_LOST:
              // Undecidable by design (ADR-0013): once, or not at all.
              byOutcome.ownerLost += 1;
              break;
            case DIED_WITH_TAB:
              byOutcome.diedWithTab += 1;
              break;
            case OTHER:
              byOutcome.other += 1;
              break;
            default:
              byOutcome.unsettled += 1;
          }
        }
        expect(byOutcome.other, [...otherCodes].join(', ')).toBe(0);
        expect(byOutcome.unsettled).toBe(0);
        expect(byOutcome.ownerLost).toBeGreaterThan(0);
        expect(crashes).toBe(Math.floor(SIZES.writes / SIZES.writesPerCrash));
        for (const tab of tabs) {
          expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
        }
        expect(stateOf(after)).toEqual(stateOf(before));
        expect(after.heapMiB).toBeLessThan(before.heapMiB + 4);
        await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
        // Reported with the numbers, so the record says how many writes met a crash.
        process.stdout.write(
          `writes under owner crashes (${transport}): ${String(byOutcome.resolved)} resolved, ${String(byOutcome.ownerLost)} OWNER_LOST_DURING_WRITE, ${String(byOutcome.diedWithTab)} died with their tab, ${String(byOutcome.reachedDevice)} reached the device\n`,
        );
      },
    );
  },
);
