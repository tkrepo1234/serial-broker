import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { MAX_PAYLOAD_BYTES, MAX_WAITING_WRITE_BYTES } from '../../../src/protocol/limits.js';
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

/** The byte at `index` of a payload with `seed`: no two payloads share a long run of bytes. */
function patternByteAt(index: number, seed: number): number {
  let value = Math.imul(index + 1, 2_654_435_761) + Math.imul(seed + 1, 40_503);
  value ^= value >>> 15;
  value = Math.imul(value, 2_246_822_519);
  return (value >>> 0) % 256;
}

function payloadOf(seed: number): Uint8Array<ArrayBuffer> {
  const payload = new Uint8Array(new ArrayBuffer(MAX_PAYLOAD_BYTES));
  for (let index = 0; index < payload.byteLength; index += 1) {
    payload[index] = patternByteAt(index, seed);
  }
  return payload;
}

/** Whether the device received exactly the payload with `seed`, in order, and nothing else. */
function deviceReceived(written: readonly Uint8Array[], seed: number): boolean {
  let index = 0;
  for (const chunk of written) {
    for (const byte of chunk) {
      if (byte !== patternByteAt(index, seed)) {
        return false;
      }
      index += 1;
    }
  }
  return index === MAX_PAYLOAD_BYTES;
}

/**
 * The largest payload one `send()` carries, again and again, from a tab that does not hold the
 * port.
 *
 * Each one is cloned onto the bus, cloned to the tab holding the port, cut into chunks for the
 * device, and reported to every tab with its bytes (docs/site/shared-ports.md, "Fast devices and
 * large writes"). What is measured is that none of those copies outlives the write: the
 * `ArrayBuffer` memory after the last payload is what it was before the first.
 */
describe.skipIf(!IS_EXTREME).each(TRANSPORT_MODES)('the largest payloads (%s)', (transport) => {
  it(
    `carries ${String(SIZES.largestPayloads)} payloads of ${String(MAX_PAYLOAD_BYTES / 1024 / 1024)} MiB back to back, and keeps none of them`,
    { timeout: 900_000 },
    async () => {
      const harness = new MeteredHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const tabs: VirtualTab[] = [];
      for (let index = 0; index < SIZES.largestPayloadTabs; index += 1) {
        const tab = harness.openTab();
        await tab.client.setup('Reader', READER_OPTIONS);
        tabs.push(tab);
      }
      await harness.advance(1_000);
      const counts = tabs.map((tab) => countTraffic(tab.client, 'Reader'));
      const issuer = tabs.at(-1);
      if (issuer === undefined) {
        throw new Error('A scenario needs at least one tab');
      }
      const atOnce = Math.floor(MAX_WAITING_WRITE_BYTES / MAX_PAYLOAD_BYTES);
      const received: boolean[] = [];
      let queuedAtOnce: unknown[] = [];

      const { before, after } = await measured(
        harness,
        { name: 'largest payloads back to back', transport },
        tabs.map((tab) => tab.client),
        {
          tabs: SIZES.largestPayloadTabs,
          payloads: SIZES.largestPayloads + atOnce,
          payloadMiB: MAX_PAYLOAD_BYTES / 1024 / 1024,
          queuedAtOnce: atOnce,
        },
        // A handful of messages per payload, however large: request, start, result, report.
        {
          sent: (SIZES.largestPayloads + atOnce) * 5,
          delivered: (SIZES.largestPayloads + atOnce) * 5 * SIZES.largestPayloadTabs,
        },
        async () => {
          for (let seed = 0; seed < SIZES.largestPayloads; seed += 1) {
            const outcome = outcomeOf(issuer.client.send('Reader', payloadOf(seed)));
            await harness.settle();
            await harness.advance(0);
            if ((await outcome) !== 'resolved') {
              throw new Error(`Payload ${String(seed)} failed: ${String(await outcome)}`);
            }
            received.push(deviceReceived(device.written, seed));
            device.written.length = 0;
          }
          // As many at once as the tab holding the port keeps waiting (ADR-0031): all of them
          // are written, in order.
          const outcomes: Promise<unknown>[] = [];
          for (let seed = 100; seed < 100 + atOnce; seed += 1) {
            outcomes.push(outcomeOf(issuer.client.send('Reader', payloadOf(seed))));
          }
          await harness.settle();
          await harness.advance(0);
          queuedAtOnce = await Promise.all(outcomes);
          const perPayload = device.written.length / atOnce;
          for (let position = 0; position < atOnce; position += 1) {
            received.push(
              deviceReceived(
                device.written.slice(position * perPayload, (position + 1) * perPayload),
                100 + position,
              ),
            );
          }
          device.written.length = 0;
        },
      );

      expect(received).toEqual(received.map(() => true));
      expect(queuedAtOnce).toEqual(Array.from({ length: atOnce }, () => 'resolved'));
      for (const [index, tab] of tabs.entries()) {
        expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
        expect(counts[index]?.sent).toBe(SIZES.largestPayloads + atOnce);
        expect(counts[index]?.errors).toBe(0);
      }
      expect(stateOf(after)).toEqual(stateOf(before));
      expect(after.heapMiB).toBeLessThan(before.heapMiB + 4);
      expect(after.arrayBufferMiB).toBeLessThan(before.arrayBufferMiB + 1);
      await expectEveryTabStillWorks(harness, tabs, device, 'Reader');
    },
  );
});
