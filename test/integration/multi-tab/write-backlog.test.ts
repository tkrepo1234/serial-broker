import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { MAX_WAITING_WRITES } from '../../../src/protocol/limits.js';
import { TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { connectedTab, READER_OPTIONS, readerHarness, twoTabs } from '../../harness/devices.js';
import { outcomeOf, queuedWritesAt } from '../../harness/outcomes.js';

/**
 * What the tab holding the port keeps of the writes other tabs hand it. How long each of them may
 * wait is `write-deadlines.test.ts`.
 */

/**
 * What waits at the port is bounded, in writes and in bytes (ADR-0019). Every tab of the origin can
 * ask the tab holding the port to write, and a script of the origin can ask as fast as it likes; a
 * queue that grew with the asking would be the one part of the library a message can make unbounded.
 */
describe('more writes at the port than it keeps', () => {
  it('refuses the writes beyond the bound, saying that nothing of them was written', async () => {
    const { harness, device, tab: owner } = await connectedTab();

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

  it('writes a request it has already accepted once, however often it is handed over again', async () => {
    const { harness, device, other: participant } = await twoTabs();

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

describe('a payload with no bytes in it', () => {
  it('is handed to the device as one empty write', async () => {
    const { device, tab } = await connectedTab();

    await tab.client.send('Reader', new Uint8Array(0));

    // Not dropped on the way: a device that answers every command needs the command, and a
    // caller that sent nothing has still sent.
    expect(device.written.map((chunk) => chunk.byteLength)).toEqual([0]);
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
