import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { MAX_WAITING_WRITES } from '../../../src/protocol/limits.js';
import type { BrowserHarness } from '../../harness/browser-harness.js';
import { TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER_OPTIONS, readerHarness } from '../../harness/devices.js';
import type { FakeDevice } from '../../harness/fake-serial.js';
import { outcomeOf, queuedWritesAt } from '../../harness/outcomes.js';

/** One byte per chunk, so that a test can let a write through chunk by chunk. */
const CHUNKED_OPTIONS = { ...READER_OPTIONS, connection: { maxWriteChunkBytes: 1 } };

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
      const { harness, device } = readerHarness({ transport });
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
        const queuedWhileSlow = queuedWritesAt(setup.owner.client);
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

/**
 * What waits at the port is bounded, in writes and in bytes (ADR-0019). Every tab of the origin can
 * ask the tab holding the port to write, and a script of the origin can ask as fast as it likes; a
 * queue that grew with the asking would be the one part of the library a message can make unbounded.
 */
describe('more writes at the port than it keeps', () => {
  it('refuses the writes beyond the bound, saying that nothing of them was written', async () => {
    const { harness, device } = readerHarness();
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);

    device.faults.hangOnWrite = true;
    const outcomes: Promise<unknown>[] = [];
    for (let index = 0; index < MAX_WAITING_WRITES + 2; index += 1) {
      outcomes.push(outcomeOf(owner.client.send('Reader', 'X')));
    }
    await harness.settle();

    const refused = await Promise.all(outcomes.slice(MAX_WAITING_WRITES));
    expect(refused).toEqual([
      expect.objectContaining({ code: SerialBrokerErrorCode.WRITE_QUEUE_FULL }),
      expect.objectContaining({ code: SerialBrokerErrorCode.WRITE_QUEUE_FULL }),
    ]);
    // The writes within the bound are untouched: they wait at the port for their own deadline.
    expect(queuedWritesAt(owner.client)).toBe(MAX_WAITING_WRITES);
  });

  it('keeps the promise that a refused write was not written, for a request it has accepted', async () => {
    const { harness, device } = readerHarness();
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const participant = harness.openTab();
    await participant.setup('Reader', READER_OPTIONS);

    device.pauseWrites();
    const outcome = outcomeOf(participant.client.send('Reader', 'PING'));
    await harness.settle();
    // The participant hands the same request over again, as it does after reaching a new broker.
    const joining = harness.openTab();
    await joining.setup('Reader', READER_OPTIONS);
    device.resumeWrites();
    await harness.settle();

    expect(await outcome).toBe('resolved');
    expect(device.writtenText()).toBe('PING');
  });
});

describe('handing a write to the device in chunks', () => {
  async function chunkSizesFor(byteLength: number, maxWriteChunkBytes: number): Promise<number[]> {
    const { harness, device } = readerHarness();
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { maxWriteChunkBytes } });

    await tab.client.send('Reader', new Uint8Array(byteLength));

    return device.written.map((chunk) => chunk.byteLength);
  }

  it('hands an empty payload over as one empty write', async () => {
    expect(await chunkSizesFor(0, 4)).toEqual([0]);
  });
});

/**
 * Writes the tab holding the port accepts from other tabs, and what it remembers of them to keep
 * each write at most once (ADR-0011).
 */

describe.each(TRANSPORT_MODES)('a write that found the port closed (%s)', (transport) => {
  it('is written once the port is open again, not answered with NOT_CONNECTED again', async () => {
    const { harness, device } = readerHarness({ transport });
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);

    const busy = harness.openBusyTab();
    await busy.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // The device goes away. The busy tab has not heard yet and sends: the tab holding the port has
    // no open port to write to, and answers NOT_CONNECTED.
    busy.hold();
    harness.serial.unplug(device);
    await harness.settle();
    const writing = busy.client.send('Reader', 'PING');
    await harness.settle();
    busy.deliverHeld();
    await harness.settle();

    // Back again: the write goes out once more, and this time it is written.
    harness.serial.plug(device);
    await harness.advance(0);
    await harness.settle();

    await expect(writing).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('PING');
  });
});
