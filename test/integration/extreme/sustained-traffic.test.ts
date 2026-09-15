import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
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

/** What the device sends, over and over: text whose two-byte characters fall across chunk ends. */
const LINE = 'T=23.5°C P=1013hPa RH=41% Ø=12.7mm ✓;';

/** Serial bytes carry a start bit, eight data bits and a stop bit: ten per byte. */
const BITS_PER_BYTE = 10;

/** The chunk size the browser hands over by default: `serial.bufferSize`. */
const CHUNK_BYTES = 255;

/**
 * A device that never stops talking, at full rate, for a simulated hour, with text decoding on.
 *
 * Every chunk is one read in the tab holding the port, one decode, and one delivery to every
 * other tab. What must not happen: a chunk lost, a character split by a chunk boundary
 * garbled, or anything kept per chunk. What is measured: that the footprint after 41 MB is the
 * footprint before, and every byte and every character was counted in every tab.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)('sustained device traffic (%s)', (transport) => {
  it(
    `delivers ${String(SIZES.trafficMinutes)} minutes at ${String(SIZES.trafficBaud)} baud to ${String(SIZES.receivers)} tabs, decoded, with nothing kept`,
    { timeout: 900_000 },
    async () => {
      const harness = new MeteredHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const options = {
        device: READER,
        serial: { baudRate: SIZES.trafficBaud, bufferSize: CHUNK_BYTES },
        // Every chunk as it is read: this counts or times chunks, not collected answers (ADR-0039).
        receive: { idleMs: 0 },
        encoding: { decodeText: true },
      };
      const tabs: VirtualTab[] = [];
      for (let index = 0; index < SIZES.receivers; index += 1) {
        const tab = harness.openTab();
        await tab.client.setup('Reader', options);
        tabs.push(tab);
      }
      await harness.advance(1_000);
      const counts = tabs.map((tab) => {
        const count = { chunks: 0, bytes: 0, characters: 0, errors: 0 };
        tab.client.subscribe('Reader', 'onReceive', (event) => {
          count.chunks += 1;
          count.bytes += event.data.byteLength;
          count.characters += event.text?.length ?? 0;
        });
        tab.client.subscribe('Reader', 'onError', () => {
          count.errors += 1;
        });
        return count;
      });
      // A stream cut into chunks with no regard for character boundaries, as a port does.
      const source = new TextEncoder().encode(LINE.repeat(64));
      const chunks: Uint8Array[] = [];
      for (let offset = 0; offset + CHUNK_BYTES <= source.byteLength; offset += CHUNK_BYTES) {
        chunks.push(source.slice(offset, offset + CHUNK_BYTES));
      }
      const chunksPerSecond = Math.floor(SIZES.trafficBaud / BITS_PER_BYTE / CHUNK_BYTES);
      const seconds = SIZES.trafficMinutes * 60;
      const groundTruth = new TextDecoder();
      let expectedChunks = 0;
      let expectedBytes = 0;
      let expectedCharacters = 0;

      const { before, after } = await measured(
        harness,
        { name: 'sustained device traffic', transport },
        tabs.map((tab) => tab.client),
        {
          tabs: SIZES.receivers,
          simulatedMinutes: SIZES.trafficMinutes,
          baud: SIZES.trafficBaud,
          chunks: seconds * chunksPerSecond,
          megabytes: Math.round((seconds * chunksPerSecond * CHUNK_BYTES) / 100_000) / 10,
        },
        // Exactly one message per chunk, delivered once to every tab but the one reading the port:
        // decoding happens in each tab, and costs no message.
        {
          sent: seconds * chunksPerSecond + 10,
          delivered: seconds * chunksPerSecond * (SIZES.receivers - 1) + 100,
        },
        async () => {
          let next = 0;
          for (let second = 0; second < seconds; second += 1) {
            for (let index = 0; index < chunksPerSecond; index += 1) {
              const chunk = chunks[next % chunks.length];
              next += 1;
              if (chunk === undefined) {
                throw new Error('No chunk to send');
              }
              device.emit(chunk);
              expectedChunks += 1;
              expectedBytes += chunk.byteLength;
              expectedCharacters += groundTruth.decode(chunk, { stream: true }).length;
            }
            await harness.advance(1_000);
          }
        },
      );

      for (const tab of tabs) {
        expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
      }
      // Every tab, the one holding the port included, counted every chunk, every byte and every
      // character - a character split by a chunk boundary was decoded whole, in every tab.
      expect(counts).toEqual(
        tabs.map(() => ({
          chunks: expectedChunks,
          bytes: expectedBytes,
          characters: expectedCharacters,
          errors: 0,
        })),
      );
      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 4);
      expect(after.arrayBufferMiB).toBeLessThan(before.arrayBufferMiB + 1);
      await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
    },
  );
});
