/**
 * The benchmark scenarios, on the simulated browser of `test/harness/`.
 *
 * What is measured here is the library's own cost: the same production classes the integration
 * tests run, wired to the fake bus, the fake serial registry and the fake locks, with every delay
 * on a clock that moves only when a scenario moves it. Two kinds of number come out of that:
 *
 * - **Simulated time**, which is exact and repeatable: how many milliseconds of the fake clock a
 *   handover or a start took, which is zero for anything that waits on no timer.
 * - **Wall-clock time**, which is what the process actually spent in the library's microtasks -
 *   structured clones, validation, dispatch - and which varies with the machine and with what
 *   else it is doing. Every wall-clock metric is a percentile over many samples for that reason,
 *   and a run says on which machine it was made.
 *
 * Nothing here asserts a bound. A scenario checks that it did what it says - every chunk arrived
 * in every tab, every write reached the device - and reports what it measured; the judgement
 * against the expectations happens in `main.ts`. See ADR-0023.
 */

import { performance } from 'node:perf_hooks';
import process from 'node:process';

import type { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { BrowserHarness, type VirtualTab } from '../../test/harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../test/harness/devices.js';
import type { TransportMode } from '../../test/harness/fake-bus.js';
import { flushMicrotasks } from '../../test/harness/fake-clock.js';
import type { FakeDevice } from '../../test/harness/fake-serial.js';
import { percentile } from '../report.js';

/** What one scenario measured, before it is judged. */
export interface Measured {
  readonly id: string;
  readonly samples: number;
  readonly values: Readonly<Record<string, number>>;
  readonly note?: string;
}

/** One scenario: an identifier the expectations know, and how to run it on a transport. */
export interface Scenario {
  readonly id: string;
  run(transport: TransportMode): Promise<Measured>;
}

const NAME = 'Reader';
/** The default read buffer: what one read of a real port delivers at most. */
const CHUNK_BYTES = 255;
/** Chunks emitted one at a time, each settled before the next: unloaded latency. */
const LATENCY_SAMPLES = 500;
/** Chunks emitted in one burst: throughput, with every tab keeping up. */
const BURST_CHUNKS = 2_000;
/** Writes before the measured ones, so that the first samples do not measure the JIT. */
const WARM_UP = 50;
/** How often a fresh harness is built for the scenarios that measure one event. */
const REPEATS = 20;

/** The scenarios, in the order they run and are reported. */
export const SCENARIOS: readonly Scenario[] = [
  deviceToTabs(1),
  deviceToTabs(5),
  deviceToTabs(10),
  tabsToDevice(1),
  tabsToDevice(10),
  tabsToDevice(100),
  oneMegabyteWrite(),
  handover('crash'),
  handover('release'),
  start('first-tab'),
  start('joining-tab'),
  steadyState(),
];

/** A harness with one granted device and no tab open yet. */
function withGrantedDevice(transport: TransportMode): {
  harness: BrowserHarness;
  device: FakeDevice;
} {
  const harness = new BrowserHarness({ transport });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  return { harness, device };
}

/**
 * Lets microtasks run, one macrotask turn at a time, until `done` holds.
 *
 * `harness.settle()` runs a fixed number of turns; a scenario that waits for two thousand chunks
 * to reach ten tabs needs as many as it needs, and one that stamps the moment something happened
 * wants the finest granularity there is.
 */
async function settleUntil(done: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 100_000; turn += 1) {
    if (done()) {
      return;
    }
    await flushMicrotasks(1);
  }
  throw new Error(`Gave up waiting for ${what}`);
}

/** Moves the library's clock and the bus's together, as real time moves both. */
async function elapse(harness: BrowserHarness, ms: number): Promise<void> {
  await harness.busClock.advance(ms);
  await harness.advance(ms);
}

/** Opens `count` tabs on the configuration and waits until every one of them reports `open`. */
async function openConnected(harness: BrowserHarness, count: number): Promise<VirtualTab[]> {
  const tabs: VirtualTab[] = [];
  for (let index = 0; index < count; index += 1) {
    const tab = harness.openTab();
    await tab.client.setup(NAME, READER_OPTIONS);
    tabs.push(tab);
  }
  await settleUntil(
    () => tabs.every((tab) => tab.client.getStatus(NAME).status === SerialBrokerStatus.Open),
    `${String(count)} tabs to open`,
  );
  return tabs;
}

/**
 * Stamps the moment a configuration reports `open`, whether that is before or after `after`
 * settles.
 *
 * `setup()` returns before the port opens, so the status may change during the call or during
 * any number of microtasks after it; checking once the call is back, and subscribing if it has
 * not happened yet, catches both without a listener registered before the configuration exists.
 */
async function openAt(client: SerialBrokerClient, after: Promise<void>): Promise<() => number> {
  let stamp = Number.NaN;
  await after;
  if (client.getStatus(NAME).status === SerialBrokerStatus.Open) {
    stamp = performance.now();
  } else {
    const unsubscribe = client.subscribe(NAME, 'onStatusChange', (event) => {
      if (event.status === SerialBrokerStatus.Open && Number.isNaN(stamp)) {
        stamp = performance.now();
        unsubscribe();
      }
    });
  }
  return () => stamp;
}

function check(condition: boolean, what: string): asserts condition {
  if (!condition) {
    throw new Error(`The benchmark did not do what it measures: ${what}`);
  }
}

function deviceToTabs(tabCount: number): Scenario {
  return {
    id: `device-to-tabs/${String(tabCount)}`,
    async run(transport) {
      const { harness, device } = withGrantedDevice(transport);
      const tabs = await openConnected(harness, tabCount);
      const chunk = new Uint8Array(CHUNK_BYTES).fill(0x55);
      const counts = tabs.map(() => 0);
      const latencies: number[] = [];
      let emittedAt = Number.NaN;
      tabs.forEach((tab, index) => {
        tab.client.subscribe(NAME, 'onReceive', (event) => {
          check(event.data.byteLength === CHUNK_BYTES, 'a chunk arrived whole');
          counts[index] = (counts[index] ?? 0) + 1;
          if (!Number.isNaN(emittedAt)) {
            latencies.push(performance.now() - emittedAt);
          }
        });
      });
      const allHave = (expected: number): boolean => counts.every((count) => count >= expected);

      for (let index = 0; index < WARM_UP; index += 1) {
        device.emit(chunk);
        await settleUntil(() => allHave(index + 1), 'a warm-up chunk');
      }

      for (let index = 0; index < LATENCY_SAMPLES; index += 1) {
        emittedAt = performance.now();
        device.emit(chunk);
        await settleUntil(() => allHave(WARM_UP + index + 1), 'a chunk in every tab');
      }
      emittedAt = Number.NaN;

      const startedAt = performance.now();
      for (let index = 0; index < BURST_CHUNKS; index += 1) {
        device.emit(chunk);
      }
      await settleUntil(() => allHave(WARM_UP + LATENCY_SAMPLES + BURST_CHUNKS), 'the burst');
      const seconds = (performance.now() - startedAt) / 1000;

      check(
        counts.every((count) => count === WARM_UP + LATENCY_SAMPLES + BURST_CHUNKS),
        'every chunk reached every tab exactly once',
      );
      check(latencies.length === LATENCY_SAMPLES * tabCount, 'every delivery was timed');
      return {
        id: this.id,
        samples: latencies.length,
        values: {
          throughput: (BURST_CHUNKS * CHUNK_BYTES) / seconds,
          latencyP50: percentile(latencies, 50),
          latencyP95: percentile(latencies, 95),
        },
        note: `${String(CHUNK_BYTES)}-byte chunks; latency from the device's push to \`onReceive\` in each tab, one chunk at a time; throughput from a burst of ${String(BURST_CHUNKS)} chunks, until the last tab has the last one.`,
      };
    },
  };
}

function tabsToDevice(writesPerSecond: number): Scenario {
  const samples = Math.min(500, Math.max(60, writesPerSecond * 5));
  return {
    id: `tabs-to-device/${String(writesPerSecond)}-per-second`,
    async run(transport) {
      const { harness, device } = withGrantedDevice(transport);
      const [, sender] = await openConnected(harness, 2);
      check(sender !== undefined, 'two tabs opened');
      const gapMs = 1000 / writesPerSecond;
      const latencies: number[] = [];

      for (let index = 0; index < WARM_UP + samples; index += 1) {
        const startedAt = performance.now();
        let settledAt = Number.NaN;
        const write = sender.client.send(NAME, 'PING\r\n').then(() => {
          settledAt = performance.now();
        });
        await settleUntil(() => !Number.isNaN(settledAt), 'a write to settle');
        await write;
        if (index >= WARM_UP) {
          latencies.push(settledAt - startedAt);
        }
        await elapse(harness, gapMs);
      }

      check(device.written.length === WARM_UP + samples, 'every write reached the device once');
      return {
        id: this.id,
        samples,
        values: { latencyP50: percentile(latencies, 50), latencyP95: percentile(latencies, 95) },
        note: 'A six-byte write from the tab that does not hold the port, timed from `send()` to its promise settling; the interval between writes is simulated time.',
      };
    },
  };
}

function oneMegabyteWrite(): Scenario {
  const repeats = 5;
  return {
    id: 'tabs-to-device/1-mb-write',
    async run(transport) {
      const { harness, device } = withGrantedDevice(transport);
      const [, sender] = await openConnected(harness, 2);
      check(sender !== undefined, 'two tabs opened');
      const payload = new Uint8Array(1024 * 1024);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = index & 0xff;
      }
      const durations: number[] = [];

      for (let repeat = 0; repeat < repeats; repeat += 1) {
        device.written.length = 0;
        const startedAt = performance.now();
        let settledAt = Number.NaN;
        const write = sender.client.send(NAME, payload).then(() => {
          settledAt = performance.now();
        });
        await settleUntil(() => !Number.isNaN(settledAt), 'the megabyte to settle');
        await write;
        durations.push(settledAt - startedAt);
        check(device.writtenBytes().byteLength === payload.byteLength, 'the megabyte arrived');
      }

      return {
        id: this.id,
        samples: repeats,
        values: { wallP50: percentile(durations, 50) },
        note: 'One `send()` of 1 MiB from the tab that does not hold the port, to its promise settling, with the default 4 KiB write chunk.',
      };
    },
  };
}

function handover(kind: 'crash' | 'release'): Scenario {
  return {
    id: `handover/${kind}`,
    async run(transport) {
      const walls: number[] = [];
      let simulated = 0;
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        const { harness, device } = withGrantedDevice(transport);
        const [owner, peer] = await openConnected(harness, 2);
        check(owner !== undefined && peer !== undefined, 'two tabs opened');
        // Read through a function: a property compared once is narrowed to that value from then on.
        const opens = (): number => device.openCount;
        check(opens() === 1, 'the port was opened once');
        let openedAt = Number.NaN;
        peer.client.subscribe(NAME, 'onStatusChange', (event) => {
          if (event.status === SerialBrokerStatus.Open) {
            openedAt = performance.now();
          }
        });

        const clockBefore = harness.clock.monotonicNow();
        const startedAt = performance.now();
        if (kind === 'crash') {
          await owner.kill();
        } else {
          await owner.client.release(NAME);
        }
        await settleUntil(() => !Number.isNaN(openedAt), 'the other tab to open the port');

        walls.push(openedAt - startedAt);
        simulated = Math.max(simulated, harness.clock.monotonicNow() - clockBefore);
        check(opens() === 2, 'the port was opened again, once');
        check(
          peer.client.getStatus(NAME).status === SerialBrokerStatus.Open,
          'the other tab holds the port',
        );
      }
      return {
        id: this.id,
        samples: REPEATS,
        values: { simulated, wallP50: percentile(walls, 50), wallP95: percentile(walls, 95) },
        note:
          kind === 'crash'
            ? 'Two tabs; the one holding the port is killed with no chance to clean up, and the other is timed until it reports `open`. Simulated time is the fake clock; wall time the process.'
            : 'Two tabs; the one holding the port releases the configuration, and the other is timed until it reports `open`.',
      };
    },
  };
}

function start(kind: 'first-tab' | 'joining-tab'): Scenario {
  return {
    id: `start/${kind}`,
    async run(transport) {
      const walls: number[] = [];
      let simulated = 0;
      for (let repeat = 0; repeat < REPEATS; repeat += 1) {
        const { harness, device } = withGrantedDevice(transport);
        if (kind === 'joining-tab') {
          await openConnected(harness, 1);
        }
        const tab = harness.openTab();
        const clockBefore = harness.clock.monotonicNow();
        const startedAt = performance.now();
        const opened = await openAt(tab.client, tab.client.setup(NAME, READER_OPTIONS));
        await settleUntil(() => !Number.isNaN(opened()), 'the tab to report open');

        walls.push(opened() - startedAt);
        simulated = Math.max(simulated, harness.clock.monotonicNow() - clockBefore);
        check(device.openCount === 1, 'the port was opened exactly once');
      }
      return {
        id: this.id,
        samples: REPEATS,
        values: { simulated, wallP50: percentile(walls, 50), wallP95: percentile(walls, 95) },
        note:
          kind === 'first-tab'
            ? 'A fresh browser with the device granted: from `setup()` to the tab reporting `open`.'
            : 'A tab joining a configuration another tab already holds open: from `setup()` to `open`.',
      };
    },
  };
}

function steadyState(): Scenario {
  const stepSeconds = 5;
  const steps = 3600 / stepSeconds;
  return {
    id: 'steady-state/one-hour',
    async run(transport) {
      const { harness, device } = withGrantedDevice(transport);
      const tabs = await openConnected(harness, 3);
      const sender = tabs[2];
      check(sender !== undefined, 'three tabs opened');
      const chunk = new Uint8Array(CHUNK_BYTES).fill(0x55);
      let received = 0;
      let resolved = 0;
      for (const tab of tabs) {
        tab.client.subscribe(NAME, 'onReceive', () => {
          received += 1;
        });
      }
      const traffic = async (seconds: number): Promise<void> => {
        for (let second = 0; second < seconds; second += 1) {
          device.emit(chunk);
          void sender.client.send(NAME, 'PING\r\n').then(() => {
            resolved += 1;
          });
        }
        // The fake device keeps every write for assertions; the benchmark measures the library.
        device.written.length = 0;
        await elapse(harness, seconds * 1000);
      };

      // A minute of warm-up, so that what is measured is the steady state and not the start.
      for (let step = 0; step < 60 / stepSeconds; step += 1) {
        await traffic(stepSeconds);
      }
      const heapBefore = heapUsedAfterCollecting();
      const timersBefore = harness.clock.pendingTimerCount + harness.busClock.pendingTimerCount;
      const startedAt = performance.now();

      for (let step = 0; step < steps; step += 1) {
        await traffic(stepSeconds);
      }

      const wall = performance.now() - startedAt;
      const heapAfter = heapUsedAfterCollecting();
      const timersAfter = harness.clock.pendingTimerCount + harness.busClock.pendingTimerCount;
      const total = 60 + steps * stepSeconds;
      check(received === total * tabs.length, 'every chunk reached every tab');
      check(resolved === total, 'every write settled');
      check(
        tabs.every((tab) => tab.client.getStatus(NAME).status === SerialBrokerStatus.Open),
        'every tab is still open',
      );

      return {
        id: this.id,
        samples: 1,
        values: {
          heapGrowth: (heapAfter - heapBefore) / 1024,
          timerGrowth: timersAfter - timersBefore,
          wall,
        },
        note: `Three tabs, one chunk and one write a second for a simulated hour, in steps of ${String(stepSeconds)} s on both clocks; heap and timers compared after a minute of warm-up and at the end, the garbage collected before each reading.`,
      };
    },
  };
}

/** The heap in use once the garbage is collected. Needs `--expose-gc`, which `run.mjs` passes. */
function heapUsedAfterCollecting(): number {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) {
    throw new Error('The steady-state scenario needs Node started with --expose-gc');
  }
  collect();
  collect();
  return process.memoryUsage().heapUsed;
}
