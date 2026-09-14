import { describe, expect, it } from 'vitest';

import type { ObservedEvent } from '../../../src/core/diagnostics.js';
import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER } from '../../harness/devices.js';

import {
  expectEveryTabStillWorks,
  IS_EXTREME,
  measured,
  MeteredHarness,
  SIZES,
  stateOf,
} from './support/extreme.js';

/**
 * A diagnostics observer (ADR-0018) with a thousand watchers on one configuration, under traffic.
 *
 * Every event on the bus is handed to every watcher: a thousand watchers make a thousand
 * callbacks per chunk. What is measured: each hears everything, one that stopped hears nothing
 * more, a collection still answers under it, and the observer holds nothing per event.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)(
  'a diagnostics observer under load (%s)',
  (transport) => {
    it(
      `hands every event to ${String(SIZES.watchers)} watchers, and to none of them once stopped`,
      { timeout: 900_000 },
      async () => {
        const TABS = 10;
        const WRITES = Math.floor(SIZES.watchedEvents / 10);
        const harness = new MeteredHarness({ transport });
        const device = harness.serial.addDevice(READER.vendorId, READER.productId);
        harness.serial.grant(device);
        const options = {
          device: READER,
          serial: { baudRate: 9600 },
          encoding: { decodeText: true },
        };
        const tabs: VirtualTab[] = [];
        for (let index = 0; index < TABS; index += 1) {
          const tab = harness.openTab();
          await tab.client.setup('Reader', options);
          tabs.push(tab);
        }
        const observer = harness.openObserver();
        await harness.advance(1_000);
        const heard = Array.from({ length: SIZES.watchers }, () => ({
          received: 0,
          sent: 0,
          other: 0,
          text: 0,
        }));
        const stops = heard.map((count) =>
          observer.watch('Reader', (event: ObservedEvent) => {
            if (event.kind === 'received') {
              count.received += 1;
              count.text += event.text?.length ?? 0;
            } else if (event.kind === 'sent') {
              count.sent += 1;
            } else {
              count.other += 1;
            }
          }),
        );
        let participantsAnswering = 0;

        const { before, after } = await measured(
          harness,
          { name: 'diagnostics observer under load', transport },
          tabs.map((tab) => tab.client),
          { tabs: TABS, watchers: SIZES.watchers, chunks: SIZES.watchedEvents, writes: WRITES },
          // The watchers are not in the budget: a thousand of them cost what one costs, since the
          // observer hands each event on in its own context.
          {
            sent: SIZES.watchedEvents + WRITES * 5 + TABS * 5,
            delivered: (SIZES.watchedEvents + WRITES * 5 + TABS * 5) * (TABS + 1),
          },
          async () => {
            for (let chunk = 0; chunk < SIZES.watchedEvents; chunk += 1) {
              device.emit(`chunk ${String(chunk)} °;`);
              if (chunk % 10 === 9) {
                await tabs[chunk % TABS]?.client.send('Reader', `write ${String(chunk)}`);
              }
              await harness.settle();
            }
            const collected = observer.collect(100);
            await harness.settle();
            await harness.advance(100);
            participantsAnswering = (await collected).participants.length;
            for (const stop of stops) {
              stop();
            }
            device.emit('nobody watches');
            await harness.settle();
          },
        );

        const expectedText = `chunk 0 °;`.length;
        expect(heard.every((count) => count.received === SIZES.watchedEvents)).toBe(true);
        expect(heard.every((count) => count.sent === WRITES && count.other === 0)).toBe(true);
        // The text every watcher saw is the owner's decoding, which reaches the observer whole.
        expect(heard[0]?.text).toBeGreaterThanOrEqual(SIZES.watchedEvents * expectedText);
        expect(participantsAnswering).toBe(TABS);
        expect(stateOf(after)).toEqual(stateOf(before));
        expect(after.heapMiB).toBeLessThan(before.heapMiB + 4);
        await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
        observer.close();
        await harness.settle();
      },
    );
  },
);
