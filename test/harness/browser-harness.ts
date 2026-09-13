import { DiagnosticsObserver } from '../../src/client/diagnostics-observer.js';
import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { ScopedLogger, NOOP_LOGGER } from '../../src/core/logger.js';
import type {
  ErrorEvent,
  Logger,
  ReceiveEvent,
  SendEvent,
  SerialBrokerOptions,
  StatusChangeEvent,
} from '../../src/core/types.js';
import type {
  KeyValueStorage,
  SerialBrokerEnvironment,
} from '../../src/environment/environment.js';

import { FakeBus, type TransportMode } from './fake-bus.js';
import { FakeClock, flushMicrotasks } from './fake-clock.js';
import { FakeLockManager } from './fake-locks.js';
import { FakeSerialRegistry } from './fake-serial.js';

/** Everything a test wants to observe about one simulated tab. */
export interface RecordedEvents {
  readonly received: ReceiveEvent[];
  readonly sent: SendEvent[];
  readonly errors: ErrorEvent[];
  readonly statuses: StatusChangeEvent[];
}

/**
 * One simulated browsing context.
 *
 * It holds a real {@link SerialBrokerClient} - the production class - wired to the harness's
 * shared fakes. Several of these in one test process are several tabs of one origin, which is
 * the arrangement this library exists to serve and the one no real browser lets a test drive
 * precisely.
 */
export class VirtualTab {
  readonly events = new Map<string, RecordedEvents>();
  #isAlive = true;

  constructor(
    readonly id: string,
    readonly client: SerialBrokerClient,
    private readonly harness: BrowserHarness,
  ) {}

  /** `false` once this tab has been closed or killed. */
  get isAlive(): boolean {
    return this.#isAlive;
  }

  /**
   * Sets up a configuration and records every event it produces.
   *
   * Recording by default is deliberate: a scenario test asserts on what a tab saw, and having
   * to remember to subscribe first is a reliable source of tests that pass for the wrong
   * reason.
   */
  async setup(name: string, options: SerialBrokerOptions): Promise<void> {
    await this.client.setup(name, options);

    const record: RecordedEvents = { received: [], sent: [], errors: [], statuses: [] };
    this.events.set(name, record);

    this.client.subscribe(name, 'onReceive', (event) => record.received.push(event));
    this.client.subscribe(name, 'onSend', (event) => record.sent.push(event));
    this.client.subscribe(name, 'onError', (event) => record.errors.push(event));
    this.client.subscribe(name, 'onStatusChange', (event) => record.statuses.push(event));

    await this.harness.settle();
  }

  /** What this tab observed for a configuration. */
  recordFor(name: string): RecordedEvents {
    const record = this.events.get(name);
    if (record === undefined) {
      throw new Error(`Tab ${this.id} has no recording for "${name}"`);
    }
    return record;
  }

  /** The statuses this tab passed through, in order. */
  statusTrail(name: string): string[] {
    return this.recordFor(name).statuses.map((event) => event.status);
  }

  /** Everything this tab received, decoded as UTF-8 and concatenated. */
  receivedText(name: string): string {
    return this.recordFor(name)
      .received.map((event) => new TextDecoder().decode(event.data))
      .join('');
  }

  /**
   * Closes this tab the way a user closing a tab does.
   *
   * Everything is released in order, so a port this tab owned is closed properly and the
   * successor takes over cleanly. Contrast with {@link kill}.
   */
  async close(): Promise<void> {
    if (!this.#isAlive) {
      return;
    }
    this.#isAlive = false;
    await this.client.dispose();
    this.harness.forgetTab(this.id);
    await this.harness.settle();
  }

  /**
   * Destroys this tab with no chance to clean up.
   *
   * A crashed renderer, an out-of-memory kill, a hard power-off. No disposer runs, no
   * `goodbye` is sent, and the port stays "open" from the device's point of view until the
   * browser tears the context down. Recovery has to come entirely from the lock being
   * released - which is the single most important behaviour in the library (ADR-0005).
   */
  async kill(): Promise<void> {
    if (!this.#isAlive) {
      return;
    }
    this.#isAlive = false;
    this.harness.destroyTab(this.id, this.client.clientId);
    await this.harness.settle();
  }
}

/** Options for {@link BrowserHarness}. */
export interface HarnessOptions {
  /** Which message bus to simulate. Scenario suites run against both. */
  readonly transport?: TransportMode;
  /**
   * In `sharedworker` mode, whether the worker script loads. With `'fails'`, tabs are cut off
   * until `bus.failWorkerScripts()` reports the failure, as a browser does for a missing script.
   */
  readonly workerScript?: 'loads' | 'fails';
  /** Fixed value returned for reconnect jitter, so backoff delays are exact. */
  readonly randomValue?: number;
  /** Receives the library's diagnostics. Useful when a scenario test misbehaves. */
  readonly logger?: Logger;
  /** Whether `debug` records may carry payload bytes. Off, as in production. */
  readonly logPayloads?: boolean;
}

/**
 * A simulated browser: several tabs, one device registry, one lock manager, one bus.
 *
 * This is the centrepiece of the test suite. Everything that makes this library difficult -
 * two tabs racing, an owner dying mid-write, a device vanishing during a handover - is an
 * ordinary, deterministic test here, expressed as a sequence of harness calls.
 */
export class BrowserHarness {
  readonly serial = new FakeSerialRegistry();
  readonly locks = new FakeLockManager();
  readonly bus: FakeBus;
  readonly clock = new FakeClock();
  /**
   * Time for the message bus: the heartbeats tabs send and the worker's sweep (ADR-0021).
   *
   * Separate from {@link clock}, so that a test asserting on the library's own timers - "no
   * reconnect is scheduled any more" - is not disturbed by the bus's, and a test about heartbeats
   * moves this one.
   */
  readonly busClock = new FakeClock();
  readonly storage = new FakeStorage();

  readonly #tabs = new Map<string, VirtualTab>();
  /** Contexts that were killed. Their timers are dropped instead of fired. */
  readonly #killedContexts = new Set<string>();
  #nextTabNumber = 0;
  #nextIdNumber = 0;

  constructor(private readonly options: HarnessOptions = {}) {
    this.bus = new FakeBus(
      options.transport ?? 'sharedworker',
      options.workerScript ?? 'loads',
      this.busClock,
    );
  }

  /** Opens a new tab of the same origin. */
  openTab(): VirtualTab {
    this.#nextTabNumber += 1;
    const id = `tab${String(this.#nextTabNumber)}`;
    const client = new SerialBrokerClient(this.createEnvironment(id));
    const tab = new VirtualTab(id, client, this);
    this.#tabs.set(id, tab);
    return tab;
  }

  /**
   * Opens a diagnostics observer on the same origin (ADR-0018).
   *
   * Not a tab in the library's sense: it has an identity on the bus, but no configuration, no
   * port and no place in any election.
   */
  openObserver(): DiagnosticsObserver {
    this.#nextTabNumber += 1;
    return new DiagnosticsObserver(
      this.createEnvironment(`observer${String(this.#nextTabNumber)}`),
    );
  }

  /** Every tab still open. */
  get tabs(): readonly VirtualTab[] {
    return [...this.#tabs.values()];
  }

  /**
   * Lets every pending microtask and promise chain run to completion.
   *
   * Called after any action that starts asynchronous work. It advances *nothing* on the
   * clock: a test that needs time to pass says so explicitly, which keeps "this is slow" and
   * "this is waiting for a reply" distinguishable.
   */
  async settle(): Promise<void> {
    await flushMicrotasks(8);
  }

  /** Advances the clock and settles. */
  async advance(byMs: number): Promise<void> {
    await this.clock.advance(byMs);
    await this.settle();
  }

  /** @internal Used by {@link VirtualTab.close}. */
  forgetTab(id: string): void {
    this.#tabs.delete(id);
    this.serial.removeContext(id);
  }

  /** @internal Used by {@link VirtualTab.kill}. */
  destroyTab(id: string, clientId: string): void {
    this.#killedContexts.add(id);
    this.#tabs.delete(id);
    this.serial.removeContext(id);
    this.locks.killContext(id);
    this.bus.killContext(id, clientId as never);
  }

  /**
   * Builds the environment a simulated tab runs on.
   *
   * Public so that a test can construct a deliberately broken one - no Web Serial, no Web
   * Locks - which is the only way to exercise the paths that refuse to start.
   */
  createEnvironment(contextId: string): SerialBrokerEnvironment {
    const logger = new ScopedLogger(this.options.logger ?? NOOP_LOGGER, { context: contextId });

    return {
      serial: this.serial.forContext(contextId),
      locks: this.locks.forContext(contextId),
      storage: this.storage,
      createTransport: (request) => this.bus.createTransport(contextId, request),
      createBroadcastChannel: (name) => this.bus.broadcastHub.create(name, contextId),
      logPayloads: this.options.logPayloads ?? false,
      // A killed tab runs no code: its timers are dropped rather than fired, as the browser
      // drops them with the tab.
      clock: {
        now: () => this.clock.now(),
        setTimer: (callback, delayMs) =>
          this.clock.setTimer(() => {
            if (!this.#killedContexts.has(contextId)) {
              callback();
            }
          }, delayMs),
        clearTimer: (handle) => {
          this.clock.clearTimer(handle);
        },
      },
      // Fixed rather than seeded: backoff delays become exactly predictable, so a test can
      // assert "the third attempt happens 1000 ms later" instead of "roughly a second".
      random: () => this.options.randomValue ?? 1,
      newId: (prefix) => {
        this.#nextIdNumber += 1;
        return `${prefix}-${contextId}-${String(this.#nextIdNumber)}`;
      },
      logger,
    };
  }
}

/**
 * `localStorage`, shared by every tab.
 *
 * Shared on purpose: storage is per origin, and a configuration persisted by one tab has to be
 * restorable by the next one to open - which is the behaviour being tested.
 */
export class FakeStorage implements KeyValueStorage {
  readonly #entries = new Map<string, string>();
  /** Set to make every operation throw, as a sandboxed iframe does. */
  isUnavailable = false;

  getItem(key: string): string | null {
    this.#assertAvailable();
    return this.#entries.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#assertAvailable();
    this.#entries.set(key, value);
  }

  removeItem(key: string): void {
    this.#assertAvailable();
    this.#entries.delete(key);
  }

  /** Replaces the stored value directly, to simulate corruption or an older version. */
  poison(key: string, value: string): void {
    this.#entries.set(key, value);
  }

  #assertAvailable(): void {
    if (this.isUnavailable) {
      throw new Error('Access to storage is denied in this context');
    }
  }
}

/** Runs a scenario against both transports, so neither is a second-class path. */
export const TRANSPORT_MODES: readonly TransportMode[] = ['sharedworker', 'broadcastchannel'];
