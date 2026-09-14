import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { BrowserHarness, TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import type { FakeDevice } from '../../harness/fake-serial.js';

/** How a promise settled, attached at once so a rejection is never unhandled. */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

/** One byte per chunk, so that a test can let a write through chunk by chunk. */
const CHUNKED_OPTIONS = { ...READER_OPTIONS, connection: { maxWriteChunkBytes: 1 } };

function queuedWritesAt(tab: VirtualTab): number | undefined {
  return tab.client.diagnostics()?.configurations[0]?.connection?.queuedWrites;
}

/**
 * Writes queue at the port behind the one being written, and a slow device can hold that one for
 * longer than `writeTimeoutMs` while it still accepts every chunk in time. A write whose issuer has
 * given up waiting was reported as never started: writing it afterwards would put a command on the
 * device that the application was told did not go out, and may have sent again.
 */
describe.each(TRANSPORT_MODES)(
  'a write waiting at the port behind a slow one (%s)',
  (transport) => {
    async function slowDevice() {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const owner = harness.openTab();
      await owner.setup('Reader', CHUNKED_OPTIONS);
      const participant = harness.openTab();
      await participant.setup('Reader', CHUNKED_OPTIONS);
      return { harness, device, owner, participant };
    }

    /**
     * Lets the first chunk of the paused slow write through after 3 s, and holds the second until the
     * test resumes writes after 6 s: each chunk within `writeTimeoutMs`, the write as a whole not.
     */
    async function writeSlowly(harness: BrowserHarness, device: FakeDevice): Promise<void> {
      await harness.advance(3_000);
      device.resumeWrites();
      device.pauseWrites();
      await harness.settle();
      await harness.advance(3_000);
    }

    for (const issuer of ['participant', 'owner'] as const) {
      it(`is never written once its deadline has passed, when the ${issuer} issued it`, async () => {
        const setup = await slowDevice();
        const { harness, device } = setup;
        const tab = setup[issuer];
        device.pauseWrites();
        const slow = outcomeOf(tab.client.send('Reader', 'AB'));
        await harness.settle();
        const waiting = outcomeOf(tab.client.send('Reader', 'Z'));
        await harness.settle();

        await writeSlowly(harness, device);
        const queuedWhileSlow = queuedWritesAt(setup.owner);
        device.resumeWrites();
        await harness.advance(0);

        expect(await waiting).toMatchObject({
          code: SerialBrokerErrorCode.WRITE_TIMEOUT,
          context: { started: false },
        });
        expect(await slow).toMatchObject({ context: { started: true } });
        expect(device.writtenText()).toBe('AB');
        // Given up on, the waiting write no longer holds its place, or its payload, at the port.
        expect(queuedWhileSlow).toBe(1);
      });
    }
  },
);

describe('handing a write to the device in chunks', () => {
  async function chunkSizesFor(byteLength: number, maxWriteChunkBytes: number): Promise<number[]> {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { maxWriteChunkBytes } });

    await tab.client.send('Reader', new Uint8Array(byteLength));

    return device.written.map((chunk) => chunk.byteLength);
  }

  it('hands an empty payload over as one empty write', async () => {
    expect(await chunkSizesFor(0, 4)).toEqual([0]);
  });

  it('hands a payload of exactly the chunk size over in one piece', async () => {
    expect(await chunkSizesFor(4, 4)).toEqual([4]);
  });

  it('hands a payload one byte longer than the chunk size over in two pieces', async () => {
    expect(await chunkSizesFor(5, 4)).toEqual([4, 1]);
  });

  it('hands a payload of several chunk sizes over in full chunks and a remainder', async () => {
    expect(await chunkSizesFor(10, 3)).toEqual([3, 3, 3, 1]);
  });

  it('hands a payload over byte by byte with a chunk size of one', async () => {
    expect(await chunkSizesFor(3, 1)).toEqual([1, 1, 1]);
  });
});
