import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER } from '../../harness/devices.js';

import {
  expectEveryTabStillWorks,
  IS_EXTREME,
  measured,
  MeteredHarness,
  outcomeOf,
  SIZES,
  stateOf,
} from './support/extreme.js';

/** Chunks the device sends per simulated second. */
const CHUNKS_PER_SECOND = 50;

/**
 * Half the tabs are frozen while the device keeps sending, with a write of their own on its way,
 * and are shown again later - with their timers first, or with the messages that arrived first.
 *
 * Everything that arrived while a tab was frozen is in the browser's queue for it, and runs when
 * the tab does (docs/site/shared-ports.md, "Frozen tabs"). What must hold: every chunk arrives,
 * in order, in every tab; the write each frozen tab issued resolves once, however its late
 * deadline and the result are ordered; and nothing of the queue is kept afterwards.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)('tabs freezing under load (%s)', (transport) => {
  it(
    `delivers ${String(SIZES.chunksUnderFreezing)} chunks in order to tabs that freeze and resume meanwhile`,
    { timeout: 900_000 },
    async () => {
      const TABS = 10;
      const harness = new MeteredHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const options = {
        device: READER,
        serial: { baudRate: 115_200 },
        // Every chunk as it is read: this counts or times chunks, not collected answers (ADR-0002).
        receive: { idleMs: 0 },
        encoding: { decodeText: true },
      };
      const tabs: VirtualTab[] = [];
      for (let index = 0; index < TABS; index += 1) {
        const tab = harness.openTab();
        await tab.client.setup('Reader', options);
        tabs.push(tab);
      }
      await harness.advance(1_000);
      // The first tab set up first and holds the port; it is never frozen (a tab using Web Serial
      // is not). The second half of the others freeze.
      const freezing = tabs.slice(Math.ceil(TABS / 2));
      const sequence = tabs.map(() => ({ next: 0, outOfOrder: 0, sent: 0, errors: 0 }));
      for (const [index, tab] of tabs.entries()) {
        const state = sequence[index];
        if (state === undefined) {
          continue;
        }
        tab.client.subscribe('Reader', 'onReceive', (event) => {
          if (Number(event.text) === state.next) {
            state.next += 1;
          } else {
            state.outOfOrder += 1;
          }
        });
        tab.client.subscribe('Reader', 'onSend', () => {
          state.sent += 1;
        });
        tab.client.subscribe('Reader', 'onError', () => {
          state.errors += 1;
        });
      }
      const seconds = Math.ceil(SIZES.chunksUnderFreezing / CHUNKS_PER_SECOND);
      const freezeAt = Math.floor(seconds / 4);
      const resumeAt = Math.floor((3 * seconds) / 4);
      const frozenWrites: Promise<unknown>[] = [];
      let emitted = 0;

      const { before, after } = await measured(
        harness,
        { name: 'tabs freezing under load', transport },
        tabs.map((tab) => tab.client),
        {
          tabs: TABS,
          frozen: freezing.length,
          chunks: seconds * CHUNKS_PER_SECOND,
          frozenSeconds: resumeAt - freezeAt,
        },
        // One message per chunk, to every other tab; a few per frozen tab's write. Freezing costs
        // nothing more: what arrived meanwhile is delivered once, when the tab runs again.
        {
          sent: seconds * CHUNKS_PER_SECOND + TABS * 10,
          delivered: (seconds * CHUNKS_PER_SECOND + TABS * 10) * TABS,
        },
        async () => {
          for (let second = 0; second < seconds; second += 1) {
            if (second === freezeAt) {
              for (const tab of freezing) {
                // Issued, then frozen: the result arrives while the tab runs nothing.
                frozenWrites.push(outcomeOf(tab.client.send('Reader', `from ${tab.id}`)));
                tab.freeze();
              }
            }
            if (second === resumeAt) {
              for (const [index, tab] of freezing.entries()) {
                await tab.resume(index % 2 === 0 ? 'timers-first' : 'tasks-first');
              }
            }
            for (let index = 0; index < CHUNKS_PER_SECOND; index += 1) {
              device.emit(String(emitted).padStart(8, '0'));
              emitted += 1;
            }
            await harness.advance(1_000);
          }
          await harness.advance(1_000);
        },
      );

      expect(await Promise.all(frozenWrites)).toEqual(freezing.map(() => 'resolved'));
      expect(device.written).toHaveLength(freezing.length);
      for (const tab of tabs) {
        expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
      }
      expect(sequence).toEqual(
        tabs.map(() => ({ next: emitted, outOfOrder: 0, sent: freezing.length, errors: 0 })),
      );
      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 4);
      await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
    },
  );
});
