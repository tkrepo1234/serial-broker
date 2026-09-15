import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { BrowserHarness, TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import type { FakeDevice } from '../../harness/fake-serial.js';

/**
 * Messages from the tab that held the port and from the tab that holds it now come from different
 * senders, and nothing orders them against each other. A tab can hear the new holder's
 * `owner-claimed` before the last words of the former one. What the former holder said is
 * attributed to its own term of holding the port, and only that term ending decides the fate of a
 * write handed to it (ADR-0026).
 */

/** How a promise settled, attached at once so a rejection is never unhandled. */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

describe.each(TRANSPORT_MODES)('a handover heard out of order (%s)', (transport) => {
  async function threeTabs() {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
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
