import { describe, expect, it } from 'vitest';

import type { SerialBrokerClient } from '../../../src/client/serial-broker-client.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import {
  SILENT_PARTICIPANT_TIMEOUT_MS,
  SWEEP_INTERVAL_MS,
} from '../../../src/protocol/heartbeat.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { storageKey } from '../../../src/storage/configuration-store.js';
import { persistenceLockName } from '../../../src/storage/persistence-hold.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * A tab left open for weeks, under load, through everything a browser and a device put it through.
 *
 * Every scenario runs for a simulated long time or a large number of operations on the fake clock,
 * and ends by comparing what can be measured from outside against where it started: timers still
 * scheduled, locks held and waited for, device listeners, and writes outstanding or queued at the
 * port. Something that grows with time or with load shows up as a difference.
 */

/** What can be counted from outside, for one configuration. */
interface Footprint {
  readonly timers: number;
  readonly deviceListeners: number;
  readonly ownerLockQueue: number;
  readonly pendingWrites: number;
  readonly queuedWritesAtPort: number;
}

function footprintOf(harness: BrowserHarness, clients: readonly SerialBrokerClient[]): Footprint {
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
    deviceListeners: harness.serial.listenerCount,
    ownerLockQueue: harness.locks.queueLength(ownerLockName('Reader')),
    pendingWrites,
    queuedWritesAtPort,
  };
}

/** Moves the library's clock and the bus's together, as real time moves both. */
async function elapse(harness: BrowserHarness, ms: number): Promise<void> {
  await harness.busClock.advance(ms);
  await harness.advance(ms);
}

/** How a promise settled, attached at once so a rejection is never unhandled. */
function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

describe.each(TRANSPORT_MODES)('a deployment left running (%s)', (transport) => {
  it('returns to where it started after six hours of the device dropping out every five minutes', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.client.setup('Reader', READER_OPTIONS);
    const participant = harness.openTab();
    await participant.client.setup('Reader', READER_OPTIONS);
    await elapse(harness, 10_000);
    const clients = [owner.client, participant.client];
    const before = footprintOf(harness, clients);

    for (let cycle = 0; cycle < 6 * 12; cycle += 1) {
      harness.serial.unplug(device);
      await elapse(harness, 2_000);
      harness.serial.plug(device);
      await elapse(harness, 298_000);
    }

    expect(footprintOf(harness, clients)).toEqual(before);
    expect(participant.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(1 + 6 * 12);
  });

  it('returns to where it started after tabs keep dying and opening for 200 rounds', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const live = [harness.openTab(), harness.openTab(), harness.openTab()];
    for (const tab of live) {
      await tab.client.setup('Reader', READER_OPTIONS);
    }
    await elapse(harness, 10_000);
    const before = footprintOf(
      harness,
      live.map((tab) => tab.client),
    );

    for (let round = 0; round < 200; round += 1) {
      // The oldest tab goes - the one holding the port, once it has been granted it - closed
      // properly on even rounds and killed on odd ones; a new tab takes its place.
      const leaving = live.shift();
      await (round % 2 === 0 ? leaving?.close() : leaving?.kill());
      const joining = harness.openTab();
      await joining.client.setup('Reader', READER_OPTIONS);
      live.push(joining);
      await elapse(harness, 2_000);
    }
    // Long enough for the worker to forget the killed tabs (ADR-0021).
    await elapse(harness, SILENT_PARTICIPANT_TIMEOUT_MS + SWEEP_INTERVAL_MS);

    expect(
      footprintOf(
        harness,
        live.map((tab) => tab.client),
      ),
    ).toEqual(before);
    expect(live.map((tab) => tab.id)).toContain(harness.locks.holderOf(ownerLockName('Reader')));
    expect(device.isOpen).toBe(true);
    if (transport === 'sharedworker') {
      expect(harness.bus.workerHost.clientCount).toBe(live.length);
    }
  });

  it('leaves nothing behind after 200 names are set up and released five times over', async () => {
    const harness = new BrowserHarness({ transport });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tabs = [harness.openTab(), harness.openTab()];
    const names = Array.from({ length: 200 }, (_, index) => `Device ${String(index)}`);
    await tabs[0]?.client.setup('Reader', READER_OPTIONS);
    await harness.settle();
    const listenersBefore = harness.serial.listenerCount + 2;

    for (let round = 0; round < 5; round += 1) {
      for (const tab of tabs) {
        for (const name of names) {
          await tab.client.setup(name, READER_OPTIONS);
        }
      }
      await harness.settle();
      for (const tab of tabs) {
        await tab.client.releaseAll();
      }
      await harness.settle();
    }

    expect(harness.clock.pendingTimerCount).toBe(0);
    // The device listeners belong to the tab, not to a configuration: one pair per tab.
    expect(harness.serial.listenerCount).toBe(listenersBefore);
    for (const name of names) {
      expect(harness.locks.holdersOf(ownerLockName(name))).toEqual([]);
      expect(harness.locks.queueLength(ownerLockName(name))).toBe(0);
      expect(harness.locks.holdersOf(persistenceLockName(name))).toEqual([]);
    }
    expect(JSON.parse(harness.storage.getItem(storageKey()) ?? '{}')).toEqual({});
  });

  it('returns to where it started after 10,000 watchers and 100 collections come and go', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);
    const observer = harness.openObserver();
    await harness.settle();
    let heardByRemoved = 0;

    for (let round = 0; round < 10_000; round += 1) {
      const stop = observer.watch(
        round % 2 === 0 ? 'Reader' : `Other ${String(round % 50)}`,
        () => {
          heardByRemoved += 1;
        },
      );
      stop();
    }
    for (let round = 0; round < 100; round += 1) {
      const collected = observer.collect(10);
      await harness.advance(10);
      await collected;
    }
    const heard: string[] = [];
    observer.watch('Reader', (event) => heard.push(event.kind));
    await harness.settle();
    device.emit('after the churn');
    await harness.settle();

    expect(heardByRemoved).toBe(0);
    expect(heard).toEqual(['received']);
    expect(harness.clock.pendingTimerCount).toBe(0);
    observer.close();
  });
});

describe('a port written to 100,000 times while the tab holding it changes', () => {
  // On the BroadcastChannel only: the simulated worker keeps every message it routes, for
  // assertions, which for this many writes is more memory than the scenario is about.
  it(
    'writes each once, settles each, and returns to where it started',
    { timeout: 120_000 },
    async () => {
      const WRITES = 100_000;
      const BATCH = 1_000;
      const harness = new BrowserHarness({ transport: 'broadcastchannel' });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const live = [harness.openTab(), harness.openTab(), harness.openTab()];
      for (const tab of live) {
        await tab.client.setup('Reader', READER_OPTIONS);
      }
      await harness.settle();
      const before = footprintOf(
        harness,
        live.map((tab) => tab.client),
      );
      let failures = 0;

      for (let batch = 0; batch < WRITES / BATCH; batch += 1) {
        const issuer = live[batch % live.length];
        const outcomes: Promise<unknown>[] = [];
        for (let index = batch * BATCH; index < (batch + 1) * BATCH; index += 1) {
          const payload = new Uint8Array(4);
          new DataView(payload.buffer).setUint32(0, index);
          outcomes.push(outcomeOf(issuer?.client.send('Reader', payload) ?? Promise.resolve()));
        }
        for (const outcome of await Promise.all(outcomes)) {
          failures += outcome === 'resolved' ? 0 : 1;
        }

        if (batch % 10 === 9) {
          // Between batches the tab holding the port goes: closed, or killed.
          const leaving = live.shift();
          await (batch % 20 === 9 ? leaving?.close() : leaving?.kill());
          const joining = harness.openTab();
          await joining.client.setup('Reader', READER_OPTIONS);
          live.push(joining);
          await harness.advance(2_000);
        }
      }
      await harness.advance(10_000);

      const written = new Set(
        device.written.map((chunk) =>
          new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength).getUint32(0),
        ),
      );
      expect(failures).toBe(0);
      expect(device.written).toHaveLength(WRITES);
      expect(written.size).toBe(WRITES);
      expect(
        footprintOf(
          harness,
          live.map((tab) => tab.client),
        ),
      ).toEqual(before);
    },
  );
});
