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
function chunkedOptions(writeTimeoutMs?: number) {
  return {
    ...READER_OPTIONS,
    connection: {
      maxWriteChunkBytes: 1,
      ...(writeTimeoutMs === undefined ? {} : { writeTimeoutMs }),
    },
  };
}

/** Lets one paused chunk through and holds the next. */
async function letOneChunkThrough(harness: BrowserHarness, device: FakeDevice): Promise<void> {
  device.resumeWrites();
  device.pauseWrites();
  await harness.settle();
}

const NOT_STARTED = { code: SerialBrokerErrorCode.WRITE_TIMEOUT, context: { started: false } };

/**
 * A write rejected with `WRITE_TIMEOUT` and `started: false` is never written afterwards (ADR-0013),
 * whatever `writeTimeoutMs` each tab runs the configuration with. The issuer decides the outcome at
 * its own deadline, so the tab holding the port must not begin a write after that deadline - neither
 * because it runs a longer setting, nor because the write reached it only part way through its time.
 */
describe.each(TRANSPORT_MODES)(
  'a write waiting at the port behind a slow one (%s)',
  (transport) => {
    async function twoTabs(
      ownerTimeoutMs: number | undefined,
      participantTimeoutMs: number | undefined,
    ) {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const owner = harness.openTab();
      await owner.setup('Reader', chunkedOptions(ownerTimeoutMs));
      const participant = harness.openTab();
      await participant.setup('Reader', chunkedOptions(participantTimeoutMs));
      return { harness, device, owner, participant };
    }

    it('is never written once its issuer gave up, when the tab holding the port waits longer', async () => {
      const { harness, device, participant } = await twoTabs(10_000, 2_000);
      device.pauseWrites();
      const slow = outcomeOf(participant.client.send('Reader', 'AB'));
      await harness.settle();
      const waiting = outcomeOf(participant.client.send('Reader', 'Z'));
      await harness.settle();

      // Each chunk within the holder's 10 s, the write as a whole beyond the issuer's 2 s.
      await harness.advance(1_500);
      await letOneChunkThrough(harness, device);
      await harness.advance(1_500);
      device.resumeWrites();
      await harness.advance(0);

      expect(await slow).toMatchObject({ context: { started: true } });
      expect(await waiting).toMatchObject(NOT_STARTED);
      expect(device.writtenText()).toBe('AB');
    });

    it('is never written, and fails early, when the tab holding the port waits less', async () => {
      const { harness, device, participant } = await twoTabs(2_000, 10_000);
      device.pauseWrites();
      const slow = outcomeOf(participant.client.send('Reader', 'AB'));
      await harness.settle();
      let isAnswered = false;
      const waiting = outcomeOf(participant.client.send('Reader', 'Z')).then((outcome) => {
        isAnswered = true;
        return outcome;
      });
      await harness.settle();

      // Each chunk within the holder's 2 s; the waiting write longer than that at the port.
      await harness.advance(1_500);
      await letOneChunkThrough(harness, device);
      await harness.advance(1_500);
      // Answered by the tab holding the port, 7 s before the issuer's own deadline.
      const answeredBeforeItsDeadline = isAnswered;
      device.resumeWrites();
      await harness.advance(0);

      expect(answeredBeforeItsDeadline).toBe(true);
      expect(await waiting).toMatchObject(NOT_STARTED);
      expect(await slow).toBe('resolved');
      expect(device.writtenText()).toBe('AB');
    });

    for (const issuer of ['participant', 'owner'] as const) {
      it(`is never written when it reached the port part way through its time, issued by the ${issuer}`, async () => {
        const setup = await twoTabs(undefined, undefined);
        const { harness, device } = setup;
        const tab: VirtualTab = setup[issuer];

        // No port to write to: both writes wait in the issuing tab, their deadlines running.
        harness.serial.unplug(device);
        await harness.settle();
        const slow = outcomeOf(tab.client.send('Reader', 'AB'));
        const waiting = outcomeOf(tab.client.send('Reader', 'Z'));
        await harness.settle();
        await harness.advance(3_000);

        // The port opens with 2 s of the default 5 s left, and the device is slow to take the first.
        device.pauseWrites();
        harness.serial.plug(device);
        await harness.advance(0);
        await harness.settle();

        // Each chunk within 5 s of its start; the waiting write begins only after 5 s from its issue.
        await harness.advance(2_500);
        await letOneChunkThrough(harness, device);
        await harness.advance(1_000);
        device.resumeWrites();
        await harness.advance(0);

        expect(await slow).toMatchObject({ context: { started: true } });
        expect(await waiting).toMatchObject(NOT_STARTED);
        expect(device.writtenText()).toBe('AB');
      });
    }
  },
);
