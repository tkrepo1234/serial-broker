import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

import type { SerialBrokerClient } from '../../../../src/client/serial-broker-client.js';
import {
  BrowserHarness,
  type HarnessOptions,
  type VirtualTab,
} from '../../../harness/browser-harness.js';
import type { FakeDevice } from '../../../harness/fake-serial.js';

/**
 * What the extreme suite shares: the switch that runs it, the sizes it runs at, a harness that
 * counts what crosses the bus, the footprint every scenario is measured by, and the report a run
 * leaves behind.
 *
 * The suite runs only with `SERIAL_BROKER_EXTREME=1`, through `npm run test:extreme`, and never
 * in CI: each scenario takes seconds to minutes, and asks for a heap the ordinary suite does not.
 * See docs/guidelines/testing.md, "The extreme suite".
 */

/** `true` when the suite is asked for. Every scenario file is `describe.skipIf(!IS_EXTREME)`. */
export const IS_EXTREME = process.env['SERIAL_BROKER_EXTREME'] === '1';

/**
 * How large each scenario runs, with the default a run under ten minutes on a development
 * machine allows. Every value can be set from the environment, so that a longer run - a
 * simulated month, a thousand tabs - is one variable away and never a code change.
 */
export const SIZES = {
  /** Tabs sharing one configuration. */
  tabs: sizeFromEnvironment('SERIAL_BROKER_EXTREME_TABS', 100),
  /** Configurations, each with its own device, set up by every one of the tabs sharing them. */
  configurations: sizeFromEnvironment('SERIAL_BROKER_EXTREME_CONFIGURATIONS', 20),
  /** Tabs sharing each of those configurations. */
  tabsPerConfiguration: sizeFromEnvironment('SERIAL_BROKER_EXTREME_TABS_PER_CONFIGURATION', 10),
  /** Simulated minutes of a device sending at full rate. */
  trafficMinutes: sizeFromEnvironment('SERIAL_BROKER_EXTREME_TRAFFIC_MINUTES', 60),
  /** Baud rate the device sends at during that time. */
  trafficBaud: sizeFromEnvironment('SERIAL_BROKER_EXTREME_TRAFFIC_BAUD', 115_200),
  /** Tabs receiving that traffic. */
  receivers: sizeFromEnvironment('SERIAL_BROKER_EXTREME_RECEIVERS', 10),
  /** Writes issued while the tab holding the port keeps crashing. */
  writes: sizeFromEnvironment('SERIAL_BROKER_EXTREME_WRITES', 10_000),
  /** Tabs issuing those writes. */
  writers: sizeFromEnvironment('SERIAL_BROKER_EXTREME_WRITERS', 20),
  /** Writes between two crashes of the tab holding the port. */
  writesPerCrash: sizeFromEnvironment('SERIAL_BROKER_EXTREME_WRITES_PER_CRASH', 100),
  /** Writes one tab accepts at its port during one long term of holding it. */
  ownerWrites: sizeFromEnvironment('SERIAL_BROKER_EXTREME_OWNER_WRITES', 50_000),
  /** Payloads of the largest size one `send()` carries, sent back to back. */
  largestPayloads: sizeFromEnvironment('SERIAL_BROKER_EXTREME_LARGEST_PAYLOADS', 8),
  /** Tabs on the configuration those payloads cross. */
  largestPayloadTabs: sizeFromEnvironment('SERIAL_BROKER_EXTREME_LARGEST_PAYLOAD_TABS', 4),
  /** Setup and release cycles. */
  cycles: sizeFromEnvironment('SERIAL_BROKER_EXTREME_CYCLES', 1_000),
  /** Simulated days of heartbeats and sweeps. */
  days: sizeFromEnvironment('SERIAL_BROKER_EXTREME_DAYS', 7),
  /** Tabs kept alive through those days. */
  longLivedTabs: sizeFromEnvironment('SERIAL_BROKER_EXTREME_LONG_LIVED_TABS', 10),
  /** Chunks the device sends while tabs freeze and resume. */
  chunksUnderFreezing: sizeFromEnvironment('SERIAL_BROKER_EXTREME_CHUNKS_UNDER_FREEZING', 5_000),
  /** Watchers on one diagnostics observer. */
  watchers: sizeFromEnvironment('SERIAL_BROKER_EXTREME_WATCHERS', 1_000),
  /** Chunks and writes the watchers see. */
  watchedEvents: sizeFromEnvironment('SERIAL_BROKER_EXTREME_WATCHED_EVENTS', 2_000),
} as const;

function sizeFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, not ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Everything that can be counted from outside about a simulated browser and its tabs.
 *
 * Measured before load and after it. What the library holds per tab or per configuration is
 * allowed to be there both times; what grows with the load is what the bounds catch. `heapMiB`
 * and `arrayBufferMiB` are read after a full garbage collection, so they need `--expose-gc`,
 * which `npm run test:extreme` sets.
 */
export interface Footprint {
  /** V8 heap in use, in MiB, after a full collection. */
  readonly heapMiB: number;
  /** `ArrayBuffer` memory outside the heap - every `Uint8Array` payload lives here - in MiB. */
  readonly arrayBufferMiB: number;
  /** Timers scheduled on the library's clock. */
  readonly timers: number;
  /** Timers scheduled on the bus's clock: heartbeats and the worker's sweep. */
  readonly busTimers: number;
  /** `connect` and `disconnect` listeners on `navigator.serial`, over every tab. */
  readonly deviceListeners: number;
  /** Listeners the applications registered on their clients, over every tab and configuration. */
  readonly listeners: number;
  /** Web Locks granted right now. */
  readonly locksHeld: number;
  /** Web Lock requests waiting behind a holder. */
  readonly locksPending: number;
  /** Writes issued and not settled, over every tab. */
  readonly pendingWrites: number;
  /** Writes queued at the port, in the tab holding it. */
  readonly queuedWritesAtPort: number;
  /** Participants the simulated worker knows; `0` on the `BroadcastChannel`. */
  readonly workerClients: number;
}

/** The footprint that must not change under load: everything but the memory readings. */
export type StateFootprint = Omit<Footprint, 'heapMiB' | 'arrayBufferMiB'>;

/**
 * The most messages a scenario's load may cost, worked out from the load before it runs.
 *
 * The bus is deterministic, so a count is the same on every run and a budget can be close to it:
 * what it catches is amplification - a message per chunk that becomes two, a reply to every
 * heartbeat that goes to every tab, watchers that cost messages. Each scenario states its budget
 * as a formula of what it does, with the measured count below it.
 */
export interface MessageBudget {
  /** Messages contexts may hand to the bus. */
  readonly sent: number;
  /** Deliveries to contexts the bus may make. */
  readonly delivered: number;
}

/** One measured scenario, as written to the report. */
export interface ScenarioResult {
  readonly scenario: string;
  readonly transport: string;
  /** What the scenario did, in numbers: tabs, chunks, writes, simulated time. */
  readonly load: Readonly<Record<string, number | string>>;
  readonly before: Footprint;
  readonly after: Footprint;
  /** Messages the bus delivered to tabs during the scenario. */
  readonly messagesDelivered: number;
  /** Messages tabs handed to the bus during the scenario. */
  readonly messagesSent: number;
  /** What the scenario was allowed to cost in messages. */
  readonly budget: MessageBudget;
  /** Wall-clock milliseconds the scenario took. */
  readonly wallMs: number;
}

/**
 * A browser harness that measures itself.
 *
 * What crossed the bus is read from the bus's own meter (`FakeBus.meter`), which counts on the
 * wire - heartbeats and handshakes included, which the transports exchange below the client -
 * because that is where a browser pays for a message: every delivery is a structured clone into
 * another context.
 */
export class MeteredHarness extends BrowserHarness {
  constructor(options: HarnessOptions = {}) {
    super(options);
  }

  /** Messages contexts handed to the bus since the harness was built. */
  get messagesSent(): number {
    return this.bus.meter.sent;
  }

  /** Messages the bus delivered to contexts since the harness was built. */
  get messagesDelivered(): number {
    return this.bus.meter.delivered;
  }

  /** Measures everything about this browser and the given tabs. */
  async footprintOf(clients: readonly SerialBrokerClient[]): Promise<Footprint> {
    let listeners = 0;
    let pendingWrites = 0;
    let queuedWritesAtPort = 0;
    for (const client of clients) {
      for (const configuration of client.diagnostics()?.configurations ?? []) {
        listeners += Object.values(configuration.listeners).reduce((sum, count) => sum + count, 0);
        pendingWrites += configuration.pendingWrites.total;
        queuedWritesAtPort += configuration.connection?.queuedWrites ?? 0;
      }
    }
    const locks = await this.locks.forContext('footprint').query?.();
    const memory = measureMemory();
    return {
      heapMiB: memory.heapMiB,
      arrayBufferMiB: memory.arrayBufferMiB,
      timers: this.clock.pendingTimerCount,
      busTimers: this.busClock.pendingTimerCount,
      deviceListeners: this.serial.listenerCount,
      listeners,
      locksHeld: locks?.held?.length ?? 0,
      locksPending: locks?.pending?.length ?? 0,
      pendingWrites,
      queuedWritesAtPort,
      workerClients: this.bus.mode === 'sharedworker' ? this.bus.workerHost.clientCount : 0,
    };
  }
}

/** The part of a footprint that load must leave as it found it. */
export function stateOf(footprint: Footprint): StateFootprint {
  const { heapMiB: _heap, arrayBufferMiB: _buffers, ...state } = footprint;
  return state;
}

/**
 * Heap and `ArrayBuffer` memory after a full garbage collection, in MiB.
 *
 * Refuses to guess: a reading without a collection first would measure when V8 last chose to
 * collect, not what is held, and a bound on it would pass or fail on that choice.
 */
export function measureMemory(): { heapMiB: number; arrayBufferMiB: number } {
  const collect = globalThis.gc;
  if (collect === undefined) {
    throw new Error(
      'The extreme suite measures memory after a garbage collection and needs --expose-gc: run it through `npm run test:extreme`, or with NODE_OPTIONS=--expose-gc.',
    );
  }
  // Twice: the first pass frees what the second pass can then finalise.
  collect();
  collect();
  const usage = process.memoryUsage();
  return { heapMiB: toMiB(usage.heapUsed), arrayBufferMiB: toMiB(usage.arrayBuffers) };
}

function toMiB(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

/**
 * Runs a scenario's load between two measurements, and records the result.
 *
 * @returns Both footprints, for the scenario's own assertions.
 */
export async function measured(
  harness: MeteredHarness,
  scenario: { readonly name: string; readonly transport: string },
  /** The tabs to measure; a function where the load replaces tabs, for the tabs alive then. */
  clients: readonly SerialBrokerClient[] | (() => readonly SerialBrokerClient[]),
  load: Readonly<Record<string, number | string>>,
  budget: MessageBudget,
  run: () => Promise<void>,
): Promise<{ readonly before: Footprint; readonly after: Footprint }> {
  const currentClients = typeof clients === 'function' ? clients : () => clients;
  const before = await harness.footprintOf(currentClients());
  const sentBefore = harness.messagesSent;
  const deliveredBefore = harness.messagesDelivered;
  const startedAt = performance.now();

  await run();

  const wallMs = Math.round(performance.now() - startedAt);
  const after = await harness.footprintOf(currentClients());
  const messagesSent = harness.messagesSent - sentBefore;
  const messagesDelivered = harness.messagesDelivered - deliveredBefore;
  // Recorded before the budget is checked, so that the record of a failing run has its numbers.
  record({
    scenario: scenario.name,
    transport: scenario.transport,
    load,
    before,
    after,
    messagesSent,
    messagesDelivered,
    budget,
    wallMs,
  });
  if (messagesSent > budget.sent || messagesDelivered > budget.delivered) {
    throw new Error(
      `${scenario.name} (${scenario.transport}) cost more messages than its budget: sent ${String(messagesSent)} of ${String(budget.sent)}, delivered ${String(messagesDelivered)} of ${String(budget.delivered)}`,
    );
  }
  return { before, after };
}

/**
 * Appends a result to the run's report, one JSON line per scenario.
 *
 * `scripts/test-extreme.mjs` names the file and turns the lines into the table in
 * `test/integration/extreme/RESULTS.md`. Without the variable the numbers are only in the
 * assertions, which is enough for a run started by hand.
 */
export function record(result: ScenarioResult): void {
  const path = process.env['SERIAL_BROKER_EXTREME_REPORT'];
  if (path === undefined || path === '') {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(result)}\n`);
}

/** How a promise settled, attached at once so a rejection is never unhandled. */
export function outcomeOf(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => 'resolved',
    (error: unknown) => error,
  );
}

/** What one tab counted of a configuration's traffic, without keeping any of it. */
export interface TrafficCount {
  received: number;
  receivedBytes: number;
  sent: number;
  errors: number;
}

/**
 * Counts a configuration's events in a tab, keeping none of them.
 *
 * `VirtualTab.setup()` records every event, which is right for a scenario test and wrong here:
 * a million chunks kept by the harness would be measured as if the library held them.
 */
export function countTraffic(client: SerialBrokerClient, name: string): TrafficCount {
  const count: TrafficCount = { received: 0, receivedBytes: 0, sent: 0, errors: 0 };
  client.subscribe(name, 'onReceive', (event) => {
    count.received += 1;
    count.receivedBytes += event.data.byteLength;
  });
  client.subscribe(name, 'onSend', () => {
    count.sent += 1;
  });
  client.subscribe(name, 'onError', () => {
    count.errors += 1;
  });
  return count;
}

/**
 * Proves every tab still works: a chunk from the device reaches all of them, and a write from
 * the last of them reaches the device and is reported to all of them.
 *
 * Every scenario ends with this. A footprint that returned to where it started proves nothing
 * on its own - a library that had quietly stopped delivering would have the smallest footprint
 * of all.
 */
export async function expectEveryTabStillWorks(
  harness: BrowserHarness,
  tabs: readonly VirtualTab[],
  device: FakeDevice,
  name: string,
): Promise<void> {
  const counts = tabs.map((tab) => countTraffic(tab.client, name));
  const writer = tabs.at(-1);
  if (writer === undefined) {
    throw new Error('A scenario needs at least one tab');
  }
  const writtenBefore = device.written.length;

  device.emit('STILL RECEIVING');
  await harness.settle();
  const outcome = outcomeOf(writer.client.send(name, 'STILL WRITING'));
  await harness.settle();
  await harness.advance(0);

  const failing = counts
    .map((count, index) => ({ tab: tabs[index]?.id ?? String(index), ...count }))
    .filter((count) => count.received !== 1 || count.sent !== 1);
  if (failing.length > 0) {
    throw new Error(
      `${String(failing.length)} of ${String(tabs.length)} tabs no longer hear everything: ${JSON.stringify(failing.slice(0, 5))}`,
    );
  }
  const result = await outcome;
  if (result !== 'resolved') {
    throw new Error(`The final write failed: ${String((result as { code?: unknown }).code)}`);
  }
  const written = device.written.slice(writtenBefore);
  if (written.length !== 1 || new TextDecoder().decode(written[0]) !== 'STILL WRITING') {
    throw new Error(
      `The final write did not reach the device exactly once: ${String(written.length)}`,
    );
  }
}
