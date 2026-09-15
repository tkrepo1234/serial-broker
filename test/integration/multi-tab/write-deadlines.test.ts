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

/**
 * The tab holding the port begins no write another tab issued without asking that tab first, and
 * that tab lets it begin only while it has not given the write up (ADR-0013). The decision is taken in
 * one turn of the issuer's event loop, so no delay on the way - a busy main thread, a machine asleep,
 * an answer crossing the deadline - makes `started: false` untrue.
 */
describe.each(TRANSPORT_MODES)(
  'the tab that issued a write decides whether it begins (%s)',
  (transport) => {
    function withTimeout(writeTimeoutMs: number | undefined) {
      return writeTimeoutMs === undefined
        ? READER_OPTIONS
        : { ...READER_OPTIONS, connection: { writeTimeoutMs } };
    }

    /** A tab holding the port whose incoming messages can be held back, and a tab that writes. */
    async function busyHolder(writeTimeoutMs?: number) {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const holder = harness.openBusyTab();
      await holder.client.setup('Reader', withTimeout(writeTimeoutMs));
      await harness.settle();
      const issuer = harness.openTab();
      await issuer.setup('Reader', withTimeout(writeTimeoutMs));
      await harness.settle();
      return { harness, device, holder, issuer };
    }

    /** A tab holding the port, and a tab that writes whose incoming messages can be held back. */
    async function busyIssuer(issuerTimeoutMs?: number) {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const holder = harness.openTab();
      await holder.setup('Reader', READER_OPTIONS);
      const issuer = harness.openBusyTab();
      await issuer.client.setup('Reader', withTimeout(issuerTimeoutMs));
      await harness.settle();
      return { harness, device, holder, issuer };
    }

    it('is never begun after its issuer gave up, when the request waited 4 s before the tab holding the port could handle it', async () => {
      const { harness, device, holder, issuer } = await busyHolder(3_000);

      // The holder's main thread is busy for 4 s with the request waiting; the issuer gives up at 3 s.
      holder.hold(issuer.client.clientId);
      const late = outcomeOf(issuer.client.send('Reader', 'LATE'));
      await harness.settle();
      await harness.advance(4_000);
      expect(await late).toMatchObject(NOT_STARTED);

      // Handled now, with its whole writeTimeoutMs still ahead of it at the port: the issuer says no.
      holder.deliverHeld();
      await harness.advance(0);
      await harness.advance(10_000);
      expect(device.written).toHaveLength(0);

      // Nothing is left holding the port's queue.
      const next = outcomeOf(issuer.client.send('Reader', 'NEXT'));
      await harness.advance(0);
      expect(await next).toBe('resolved');
      expect(device.writtenText()).toBe('NEXT');
    });

    it('is written once, and reported as started, when its issuer let it begin just before its deadline', async () => {
      const { harness, device, holder, issuer } = await busyIssuer(2_000);

      // The question of the tab holding the port waits in the busy issuer until 1 ms before its deadline.
      device.pauseWrites();
      issuer.hold(holder.client.clientId);
      const outcome = outcomeOf(issuer.client.send('Reader', 'PING'));
      await harness.settle();
      await harness.advance(1_999);
      expect(device.written).toHaveLength(0);
      issuer.deliverHeld();
      await harness.settle();

      // The deadline passes before the device has taken the write: it was let begin, so it is started.
      await harness.advance(1);
      expect(await outcome).toMatchObject({
        code: SerialBrokerErrorCode.WRITE_TIMEOUT,
        context: { started: true },
      });
      device.resumeWrites();
      await harness.advance(0);
      await harness.advance(10_000);

      expect(device.writtenText()).toBe('PING');
      expect(device.written).toHaveLength(1);
    });

    for (const ending of ['closes', 'crashes'] as const) {
      it(`is never written when its issuer ${ending} before answering, and the port's queue goes on`, async () => {
        const { harness, device, holder, issuer } = await busyIssuer();

        issuer.hold(holder.client.clientId);
        void outcomeOf(issuer.client.send('Reader', 'ORPHAN'));
        await harness.settle();
        if (ending === 'closes') {
          await issuer.client.dispose();
          harness.forgetTab('busy');
        } else {
          harness.destroyTab('busy', issuer.client.clientId);
        }
        await harness.settle();

        // Queued behind the question, which the holder waits on for its own writeTimeoutMs of 5 s.
        await harness.advance(1_000);
        const next = outcomeOf(holder.client.send('Reader', 'NEXT'));
        await harness.advance(3_900);
        expect(device.written).toHaveLength(0);
        await harness.advance(100);

        expect(await next).toBe('resolved');
        expect(device.writtenText()).toBe('NEXT');
      });
    }
  },
);
