import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

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

  it('writes once a write the former holder performed, when its claim arrives before any word of it', async () => {
    const { harness, device, first, busy } = await threeTabs();

    // Everything the first tab says about the write is late, even that it began.
    busy.hold(first.client.clientId);
    const outcome = outcomeOf(busy.client.send('Reader', 'PING'));
    await harness.settle();
    expect(device.writtenText()).toBe('PING');

    await first.close();
    await harness.advance(0);
    busy.deliverHeld();
    await harness.settle();

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(1);
  });

  it('writes once a write a crashed holder performed, when its words arrive before its lock is freed', async () => {
    const { harness, device, first, busy } = await threeTabs();

    busy.hold(first.client.clientId);
    const outcome = outcomeOf(busy.client.send('Reader', 'PING'));
    await harness.settle();
    expect(device.writtenText()).toBe('PING');

    // The tab crashes, and its words arrive while the browser is still tearing it down - before
    // the busy tab is granted the lock of its term, which is what ends the term (ADR-0030).
    const crashing = first.kill();
    busy.deliverHeld();
    await crashing;

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(1);
  });

  it('hands on a write whose only word arrives after the browser has freed a crashed holder`s lock', async () => {
    const { harness, device, first, busy } = await threeTabs();

    busy.hold(first.client.clientId);
    const outcome = outcomeOf(busy.client.send('Reader', 'PING'));
    await harness.settle();
    expect(device.writtenText()).toBe('PING');

    // What no library can decide, and what the lock cannot decide either: the crashed tab wrote
    // this and said so, but nothing of that had arrived when the browser freed its lock. The write
    // looks like one that never reached it, and is handed to the next tab - which writes it again.
    // The tab that crashes has to be writing at that very moment for this to happen (ADR-0030).
    await first.kill();
    busy.deliverHeld();
    await harness.settle();

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(2);
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
