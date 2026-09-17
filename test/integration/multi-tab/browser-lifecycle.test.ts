import { describe, expect, it } from 'vitest';

import type { SerialBrokerClient } from '../../../src/client/serial-broker-client.js';
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

/** Timers still scheduled, and writes outstanding or queued at the port, across the given tabs. */
function footprintOf(harness: BrowserHarness, clients: readonly SerialBrokerClient[]) {
  let pendingWrites = 0;
  let queuedWritesAtPort = 0;
  for (const client of clients) {
    for (const configuration of client.diagnostics()?.configurations ?? []) {
      pendingWrites += configuration.pendingWrites.total;
      queuedWritesAtPort += configuration.connection?.queuedWrites ?? 0;
    }
  }
  return {
    timers: harness.clock.pendingTimerCount,
    ownerLockQueue: harness.locks.queueLength(ownerLockName('Reader')),
    pendingWrites,
    queuedWritesAtPort,
  };
}

/**
 * What a browser does to a tab over a long life: hides it and throttles its timers, freezes it,
 * discards it, suspends the whole machine, and lets the system clock be set. See "Long-running
 * tabs" in docs/site/shared-ports.md for what the library can and cannot know in each case.
 */
describe.each(TRANSPORT_MODES)('the browser lifecycle (%s)', (transport) => {
  async function twoTabs(options: object = READER_OPTIONS) {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.client.setup('Reader', options);
    const participant = harness.openTab();
    await participant.client.setup('Reader', options);
    await harness.settle();
    return { harness, device, owner, participant };
  }

  it('is open again in every tab when the machine wakes after an hour and the adapter re-enumerates', async () => {
    const { harness, device, owner, participant } = await twoTabs();
    const clients = [owner.client, participant.client];
    const before = footprintOf(harness, clients);

    owner.freeze();
    participant.freeze();
    await harness.advance(3_600_000);
    await owner.resume('timers-first');
    await participant.resume('timers-first');
    // USB devices are commonly reset on wake: the adapter disappears and comes back.
    harness.serial.unplug(device);
    await harness.advance(1_000);
    harness.serial.plug(device);
    await harness.advance(1_000);
    const outcome = outcomeOf(participant.client.send('Reader', 'AWAKE'));
    await harness.settle();

    expect(await outcome).toBe('resolved');
    expect(device.writtenText()).toBe('AWAKE');
    expect(owner.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(participant.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(footprintOf(harness, clients)).toEqual(before);
  });

  it('writes each write of a tab whose timers run once a minute exactly once, minute after minute', async () => {
    const { harness, device, owner, participant } = await twoTabs();
    const clients = [owner.client, participant.client];
    const before = footprintOf(harness, clients);
    const outcomes: Promise<unknown>[] = [];

    harness.throttleTimers(participant.id);
    for (let minute = 0; minute < 10; minute += 1) {
      for (let index = 0; index < 10; index += 1) {
        outcomes.push(
          outcomeOf(participant.client.send('Reader', `${String(minute)}.${String(index)};`)),
        );
      }
      await harness.advance(60_000);
      await harness.runThrottledTimers(participant.id);
    }
    await harness.stopThrottlingTimers(participant.id);
    await harness.advance(1_000);

    const settled = await Promise.all(outcomes);
    expect(settled.every((outcome) => outcome === 'resolved')).toBe(true);
    expect(device.written).toHaveLength(100);
    expect(new Set(device.written.map((chunk) => new TextDecoder().decode(chunk))).size).toBe(100);
    expect(footprintOf(harness, clients)).toEqual(before);
  });

  it('withdraws a write waiting at the port on schedule when the wall clock was set back an hour', async () => {
    const { harness, device, participant } = await twoTabs({
      ...READER_OPTIONS,
      connection: { maxWriteChunkBytes: 1 },
    });
    device.pauseWrites();
    void outcomeOf(participant.client.send('Reader', 'AB'));
    await harness.settle();
    const waiting = outcomeOf(participant.client.send('Reader', 'Z'));
    await harness.settle();

    harness.clock.jumpWallClock(-3_600_000);
    await harness.advance(3_000);
    device.resumeWrites();
    device.pauseWrites();
    await harness.settle();
    await harness.advance(3_000);
    device.resumeWrites();
    await harness.advance(0);

    expect(await waiting).toMatchObject({
      code: SerialBrokerErrorCode.WRITE_TIMEOUT,
      context: { started: false },
    });
    expect(device.writtenText()).toBe('AB');
  });

  it('writes a write waiting at the port when the wall clock is set forward, its time not being up', async () => {
    const { harness, device, participant } = await twoTabs({
      ...READER_OPTIONS,
      connection: { maxWriteChunkBytes: 1 },
    });
    device.pauseWrites();
    void outcomeOf(participant.client.send('Reader', 'AB'));
    await harness.settle();
    const waiting = outcomeOf(participant.client.send('Reader', 'Z'));
    await harness.settle();

    await harness.advance(1_000);
    harness.clock.jumpWallClock(3_600_000);
    device.resumeWrites();
    await harness.settle();
    const next = outcomeOf(participant.client.send('Reader', 'N'));
    await harness.settle();

    // How long a write has waited is measured on the monotonic clock (ADR-0014): the system time
    // being set forward an hour refuses nothing that is still within `writeTimeoutMs`.
    expect(await waiting).toBe('resolved');
    expect(await next).toBe('resolved');
    expect(device.writtenText()).toBe('ABZN');
  });

  it('lets a frozen tab that is discarded leave the queue for the port, as a closed tab does', async () => {
    const { harness, owner, participant } = await twoTabs();
    const frozen = harness.openTab();
    await frozen.client.setup('Reader', READER_OPTIONS);
    await harness.settle();
    const queuedWithFrozen = harness.locks.queueLength(ownerLockName('Reader'));

    frozen.freeze();
    await frozen.kill();
    await owner.close();
    await harness.advance(2_000);

    expect(queuedWithFrozen).toBe(2);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBe(participant.id);
    expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(0);
    expect(participant.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });
});
