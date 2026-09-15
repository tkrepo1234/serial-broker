import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/** How a promise settled, attached at once so a rejection is never unhandled. */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

/**
 * A hidden tab can be frozen by the browser, and every tab stops with a machine that sleeps. A
 * frozen tab runs neither timers nor messages; when it resumes, both are queued, in no defined order
 * between them. What the tab decides on resume must not contradict what it has already been told.
 */
describe.each(TRANSPORT_MODES)('a tab that was frozen (%s)', (transport) => {
  async function twoTabs() {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const participant = harness.openTab();
    await participant.setup('Reader', READER_OPTIONS);
    return { harness, device, owner, participant };
  }

  it('resolves a write that succeeded while it was frozen, when its deadline runs before the result on resume', async () => {
    const { harness, device, participant } = await twoTabs();

    // Let begin before the freeze - a frozen tab lets nothing begin (ADR-0013) - and taken by the
    // device while it is frozen.
    device.pauseWrites();
    const outcome = outcomeOf(participant.client.send('Reader', 'PING'));
    await harness.settle();
    participant.freeze();
    device.resumeWrites();
    await harness.advance(60_000);
    expect(device.writtenText()).toBe('PING');

    await participant.resume('timers-first');
    await harness.advance(0);

    expect(await outcome).toBe('resolved');
  });

  for (const order of ['timers-first', 'tasks-first'] as const) {
    it(`begins nothing while the issuing tab is frozen, and says started: false on resume (${order})`, async () => {
      const { harness, device, participant } = await twoTabs();

      // Frozen before the tab holding the port could ask: nobody lets the write begin, and the
      // holder stops waiting for the answer at its own writeTimeoutMs.
      const outcome = outcomeOf(participant.client.send('Reader', 'PING'));
      participant.freeze();
      await harness.advance(60_000);
      expect(device.written).toHaveLength(0);

      await participant.resume(order);
      await harness.advance(0);

      expect(await outcome).toMatchObject({
        code: SerialBrokerErrorCode.WRITE_TIMEOUT,
        context: { started: false },
      });
      await harness.advance(10_000);
      expect(device.written).toHaveLength(0);
    });
  }

  it('still times a write out that no word of arrived while it was frozen', async () => {
    const { harness, device, participant } = await twoTabs();
    device.faults.hangOnWrite = true;

    const outcome = outcomeOf(participant.client.send('Reader', 'PING'));
    await harness.settle();
    participant.freeze();
    await harness.advance(60_000);
    await participant.resume('timers-first');
    await harness.advance(0);

    expect(await outcome).toMatchObject({ code: SerialBrokerErrorCode.WRITE_TIMEOUT });
  });

  it('writes once a write the former holder performed, when the deadline runs before its words on resume', async () => {
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

    // The busy tab lets the first tab begin the write. The first tab's words after that are later in
    // the busy tab's queue than the second tab's claim, and the busy tab is frozen after hearing it.
    device.pauseWrites();
    const outcome = outcomeOf(busy.client.send('Reader', 'PING'));
    await harness.settle();
    busy.hold(first.client.clientId);
    device.resumeWrites();
    await harness.settle();
    expect(device.writtenText()).toBe('PING');
    await first.close();
    await harness.advance(0);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(second.id);

    busy.freeze();
    await harness.advance(60_000);
    await busy.resume('timers-first');
    busy.deliverHeld();
    await harness.advance(0);

    expect(await outcome).toBe('resolved');
    expect(device.written).toHaveLength(1);
    expect(busy.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });
});
