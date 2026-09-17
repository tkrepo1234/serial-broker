import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { brokerChannelName, ownerLockName } from '../../../src/protocol/version.js';
import type { BrowserHarness } from '../../harness/browser-harness.js';
import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER_OPTIONS, readerHarness } from '../../harness/devices.js';
import type { FakeDevice } from '../../harness/fake-serial.js';
import { outcomeOf, queuedWritesAt } from '../../harness/outcomes.js';

/**
 * Messages from the tab that held the port and from the tab that holds it now come from different
 * senders, and nothing orders them against each other. A tab can hear the new holder's
 * `owner-claimed` before the last words of the former one. What the former holder said is
 * attributed to its own term of holding the port, and only that term ending decides the fate of a
 * write handed to it (ADR-0030).
 */

describe.each(TRANSPORT_MODES)('a handover heard out of order (%s)', (transport) => {
  async function threeTabs() {
    const { harness, device } = readerHarness({ transport });
    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    const second = harness.openTab();
    await second.setup('Reader', READER_OPTIONS);
    const busy = harness.openBusyTab();
    await busy.client.setup('Reader', READER_OPTIONS);
    await harness.settle();
    return { harness, device, first, second, busy };
  }

  it('resolves a write the former holder finished before letting go, whose result arrives after the new claim', async () => {
    const { harness, device, first, second, busy } = await threeTabs();

    // The write starts at the first tab, and the busy tab hears so.
    device.pauseWrites();
    const outcome = outcomeOf(busy.client.send('Reader', 'PING'));
    await harness.settle();

    // From here on the first tab's words are late. It finishes the write, lets go, and the second
    // tab claims the port - which the busy tab hears at once.
    busy.hold(first.client.clientId);
    const closing = first.close();
    await harness.settle();
    device.resumeWrites();
    await closing;
    await harness.advance(0);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(second.id);

    busy.deliverHeld();
    await harness.settle();

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(1);
  });

  /**
   * Lets the first tab begin the busy tab's write, then holds everything the first tab says after
   * that: the write is taken by the device, and its result is late.
   */
  async function writtenWithItsResultLate(
    harness: BrowserHarness,
    device: FakeDevice,
    busy: ReturnType<BrowserHarness['openBusyTab']>,
    first: VirtualTab,
  ): Promise<{ readonly outcome: Promise<unknown> }> {
    device.pauseWrites();
    const outcome = outcomeOf(busy.client.send('Reader', 'PING'));
    await harness.settle();
    busy.hold(first.client.clientId);
    device.resumeWrites();
    await harness.settle();
    expect(device.writtenText()).toBe('PING');
    // Wrapped: an async function returning the promise itself would wait for it to settle.
    return { outcome };
  }

  it('writes once a write the former holder performed, when its claim arrives before the result', async () => {
    const { harness, device, first, busy } = await threeTabs();
    const { outcome } = await writtenWithItsResultLate(harness, device, busy, first);

    await first.close();
    await harness.advance(0);
    busy.deliverHeld();
    await harness.settle();

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(1);
  });

  it('writes once a write a crashed holder performed, when its words arrive before its lock is freed', async () => {
    const { harness, device, first, busy } = await threeTabs();
    const { outcome } = await writtenWithItsResultLate(harness, device, busy, first);

    // The tab crashes, and its words arrive while the browser is still tearing it down - before
    // the busy tab is granted the lock of its term, which is what ends the term (ADR-0030).
    const crashing = first.kill();
    busy.deliverHeld();
    await crashing;

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(1);
  });

  it('never repeats a write a crashed holder was let begin, whose result arrives after its lock is freed', async () => {
    const { harness, device, first, busy } = await threeTabs();
    const { outcome } = await writtenWithItsResultLate(harness, device, busy, first);

    // The busy tab let the first tab begin the write, so it knows the write may have reached the
    // device, whatever has arrived of the rest (ADR-0013).
    await first.kill();
    busy.deliverHeld();
    await harness.advance(0);

    expect(await outcome).toMatchObject({ code: SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE });
    expect(device.written).toHaveLength(1);
  });

  it('hands on, and writes once, a write whose question arrives only after the browser freed a crashed holder`s lock', async () => {
    const { harness, device, first, busy } = await threeTabs();

    // The first tab asks whether it may begin, and the question is late: it begins nothing.
    busy.hold(first.client.clientId);
    const outcome = outcomeOf(busy.client.send('Reader', 'PING'));
    await harness.settle();
    expect(device.written).toHaveLength(0);

    // Its term ends with nothing let begin, so the write is handed to the next tab - not a repeat.
    // The question that arrives afterwards names an ended term and is answered no.
    await first.kill();
    await harness.advance(0);
    busy.deliverHeld();
    await harness.advance(0);

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(1);
  });

  it('hands a write waiting for its issuer`s answer on at once when the holder closes, and writes it once', async () => {
    const { harness, device, first, second, busy } = await threeTabs();

    busy.hold(first.client.clientId);
    const outcome = outcomeOf(busy.client.send('Reader', 'PING'));
    await harness.settle();

    // The clock does not move: closing does not wait for an answer that may never come. The write
    // has not begun, and goes back to its issuer to be handed on.
    await first.close();
    await harness.advance(0);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(second.id);
    expect(device.written).toHaveLength(0);

    // The first tab's question arrives late, then that it did not write it, then its goodbye.
    busy.deliverHeld();
    await harness.advance(0);

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(1);
  });

  it('keeps the new holder`s status when the former holder`s owner-released arrives late', async () => {
    const { harness, first, busy } = await threeTabs();

    busy.hold(first.client.clientId);
    await first.close();
    await harness.advance(0);
    expect(busy.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);

    busy.deliverHeld();
    await harness.settle();

    expect(busy.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });
});

describe.each(TRANSPORT_MODES)('the tab that holds the port (%s)', (transport) => {
  it('keeps its own status when a status from the former holder arrives late', async () => {
    const { harness, device } = readerHarness({ transport });
    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    const busy = harness.openBusyTab();
    await busy.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // The first tab loses the connection and says so; the busy tab has not heard yet when the
    // first tab dies and hands it the port.
    busy.hold();
    device.breakStream();
    await harness.settle();
    await first.kill();
    await harness.advance(0);
    expect(busy.client.getStatus('Reader').status).toBe('open');
    busy.deliverHeld();
    await harness.settle();

    expect(busy.client.getStatus('Reader').status).toBe('open');
    await busy.client.send('Reader', 'PING');
    expect(device.writtenText()).toBe('PING');
  });

  it('writes its own write once when a former holder turns it away late', async () => {
    const { harness, device } = readerHarness({ transport });
    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    const busy = harness.openBusyTab();
    await busy.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // The busy tab still believes the first tab's port is open, and sends two writes there. The
    // first tab has lost the connection and turns both away; the answers are held.
    busy.hold();
    device.breakStream();
    await harness.settle();
    void busy.client.send('Reader', 'ONE').catch(() => undefined);
    void busy.client.send('Reader', 'TWO').catch(() => undefined);
    await harness.settle();

    // The busy tab takes the port over and writes both itself: the first hangs at the device, the
    // second waits behind it. Then the old answers arrive.
    device.faults.hangOnWrite = true;
    await first.kill();
    expect(queuedWritesAt(busy.client)).toBe(2);
    busy.deliverHeld();
    await harness.settle();

    expect(queuedWritesAt(busy.client)).toBe(2);
  });
});

describe('a write of another tab during a clean release', () => {
  it('is sent once, and written by the next holder once the term has ended', async () => {
    const { harness, device } = readerHarness({ transport: 'broadcastchannel' });
    const holder = harness.openTab();
    await holder.setup('Reader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('Reader', READER_OPTIONS);
    const requests: unknown[] = [];
    const spy = harness.bus.broadcastHub.create(brokerChannelName(), 'spy');
    spy.addEventListener('message', (event: { data: unknown }) => {
      if ((event.data as { type?: unknown }).type === 'write-request') {
        requests.push(event.data);
      }
    });

    // A write of the other tab is in flight at the port, so the release waits for its answer, and
    // the next write reaches the holding tab after it let go of the port and before its
    // owner-released.
    device.pauseWrites();
    const first = other.client.send('Reader', 'A').catch((error: unknown) => error);
    await harness.settle();
    const releasing = holder.client.release('Reader');
    for (let round = 0; round < 10; round += 1) {
      await harness.settle();
    }
    const second = other.client.send('Reader', 'B');
    for (let round = 0; round < 20; round += 1) {
      await harness.settle();
    }

    // One request per write: a releasing tab hears nothing more, so nothing turns the second write
    // away to be sent to the same term again; its issuer waits for the term to end.
    expect(requests).toHaveLength(2);

    device.resumeWrites();
    // The release completes and the write is handed on within the first half second. One jump to
    // 5 s would hand it on only at the moment its issuer's deadline runs out, where it is rightly
    // not begun (ADR-0013).
    await harness.advance(500);
    await harness.advance(4_500);
    await releasing;
    await first;
    await harness.settle();
    await expect(second).resolves.toBeUndefined();
    expect(device.writtenText()).toContain('B');
  });
});
