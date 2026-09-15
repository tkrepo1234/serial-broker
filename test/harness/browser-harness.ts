import { DiagnosticsObserver } from '../../src/client/diagnostics-observer.js';
import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import type { TimerHandle } from '../../src/core/clock.js';
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
  SerialLike,
  SerialBrokerEnvironment,
} from '../../src/environment/environment.js';
import type { ProtocolMessage } from '../../src/protocol/messages.js';

import { FakeBus, type TransportMode, type WorkerScript } from './fake-bus.js';
import { FakeClock, flushMicrotasks } from './fake-clock.js';
import { FakeLockManager } from './fake-locks.js';
import { FakeSerialRegistry } from './fake-serial.js';

/**
 * What every simulated `Math.random()` returns: the top of its range.
 *
 * Not 1, which `Math.random()` never returns - code that treated 1 specially would pass here and
 * misbehave in a browser - but close enough that every backoff delay rounds to the full delay, so
 * a schedule stays a sequence of round numbers a test can name.
 */
export const JITTER_DRAW = 1 - Number.EPSILON;

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

  /** The codes of the errors this tab was told about, in order. */
  errorCodes(name: string): string[] {
    return this.recordFor(name).errors.map((event) => event.error.code);
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
   * Freezes this tab, as the browser freezes a hidden tab, or suspends every tab with the machine.
   *
   * See {@link BrowserHarness.freezeContext} for what stops and what goes on.
   */
  freeze(): void {
    this.harness.freezeContext(this.id);
  }

  /** Resumes a frozen tab. See {@link BrowserHarness.resumeContext}. */
  async resume(order: ResumeOrder = 'tasks-first'): Promise<void> {
    await this.harness.resumeContext(this.id, order);
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

/**
 * Which of a frozen tab's held work runs first when it resumes.
 *
 * The browser keeps timers and messages in separate task queues and promises no order between them
 * on resume, so a test chooses one - as it chooses an interleaving anywhere else. Within each kind
 * the order they were queued in is kept.
 */
export type ResumeOrder = 'timers-first' | 'tasks-first';

/** Work a frozen context could not run: a timer that fell due, or a task - a message, an event. */
interface HeldWork {
  readonly kind: 'timer' | 'task';
  readonly run: () => void;
  /** The handle of a held timer, so that clearing the timer still cancels it. */
  readonly timer?: TimerHandle;
}

/** Options for {@link BrowserHarness}. */
export interface HarnessOptions {
  /** Which message bus to simulate. Scenario suites run against both. */
  readonly transport?: TransportMode;
  /**
   * In `sharedworker` mode, whether the worker script loads. With `'fails'`, tabs are cut off
   * until `bus.failWorkerScripts()` reports the failure, as a browser does for a missing script.
   */
  readonly workerScript?: WorkerScript;
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
   * Time for the message bus: the deadline of the worker's handshake (ADR-0041).
   *
   * Separate from {@link clock}, so that a test asserting on the library's own timers - "no
   * reconnect is scheduled any more" - is not disturbed by the bus's, and a test about a worker
   * that never answers moves this one.
   */
  readonly busClock = new FakeClock();
  readonly storage = new FakeStorage();

  readonly #tabs = new Map<string, VirtualTab>();
  /** Contexts that were killed. Their timers are dropped instead of fired. */
  readonly #killedContexts = new Set<string>();
  /**
   * Contexts that are frozen, or resuming, with the work they were handed meanwhile, in order.
   *
   * A resuming context stays here until what it held has run, so that work arriving meanwhile queues
   * behind it, as it does in the browser's task queues.
   */
  readonly #frozenContexts = new Map<string, HeldWork[]>();
  /** Contexts whose timers are held, as a long-hidden tab's are, with the timers held so far. */
  readonly #throttledContexts = new Map<string, HeldWork[]>();
  #nextTabNumber = 0;
  #nextIdNumber = 0;

  constructor(private readonly options: HarnessOptions = {}) {
    this.bus = new FakeBus(
      options.transport ?? 'sharedworker',
      options.workerScript ?? 'loads',
      this.busClock,
      this.locks,
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

  /**
   * Opens a tab whose incoming messages can be held back, as a busy main thread holds them back.
   *
   * `hold()` keeps every message that arrives from then on; `deliverHeld()` hands them to the tab
   * in order, and lets later ones through again. What the tab sends is never held. The tab records
   * nothing, so a test asserts on the device and on what its calls return.
   *
   * `hold(from)` keeps only the messages of one sender and lets the others through: messages from
   * different tabs have no defined order between them, while a sender's own messages keep theirs,
   * which holding all of one sender's messages preserves.
   */
  openBusyTab(id = 'busy'): {
    readonly client: SerialBrokerClient;
    readonly hold: (from?: string) => void;
    readonly deliverHeld: () => void;
    readonly freeze: () => void;
    readonly resume: (order?: ResumeOrder) => Promise<void>;
  } {
    const held: ProtocolMessage[] = [];
    let isHolding = false;
    let heldSender: string | undefined;
    let deliver: (message: ProtocolMessage) => void = () => undefined;
    const environment = this.createEnvironment(id);
    const client = new SerialBrokerClient({
      ...environment,
      createTransport: (request) => {
        deliver = request.onMessage;
        return environment.createTransport({
          ...request,
          onMessage: (message) => {
            if (isHolding && (heldSender === undefined || message.from === heldSender)) {
              held.push(message);
            } else {
              request.onMessage(message);
            }
          },
        });
      },
    });
    return {
      client,
      hold: (from) => {
        isHolding = true;
        heldSender = from;
      },
      deliverHeld: () => {
        isHolding = false;
        heldSender = undefined;
        for (const message of held.splice(0)) {
          deliver(message);
        }
      },
      freeze: () => {
        this.freezeContext(id);
      },
      resume: async (order = 'tasks-first') => {
        await this.resumeContext(id, order);
        await this.settle();
      },
    };
  }

  /**
   * Freezes a context: the page lifecycle's `frozen` state, or a machine that went to sleep.
   *
   * What the browser stops is held, in order: timers that fall due, messages from the bus, device
   * `connect` and `disconnect` events, and the callback of a lock granted meanwhile - the lock
   * itself is granted and held, as the lock manager lives outside the page. Time goes on, and what
   * other contexts do goes on.
   *
   * Not held: the deadline of the worker's handshake, which runs on the bus clock in `fake-bus.ts`,
   * and the port's streams. Chromium does not freeze a page that uses Web Serial or holds a lock
   * another page waits for, so a frozen tab holding an open port is not a state to test against.
   */
  freezeContext(id: string): void {
    if (!this.#frozenContexts.has(id)) {
      this.#frozenContexts.set(id, []);
    }
  }

  /**
   * Resumes a frozen context, running what it held one task at a time, with the microtasks each
   * task queued running before the next task, as after any task in a browser.
   *
   * @param order - Whether the timers that fell due run before the tasks that arrived, or after.
   */
  async resumeContext(id: string, order: ResumeOrder = 'tasks-first'): Promise<void> {
    const held = this.#frozenContexts.get(id);
    if (held === undefined) {
      return;
    }
    const first = order === 'timers-first' ? 'timer' : 'task';
    const ordered = [
      ...held.filter((work) => work.kind === first),
      ...held.filter((work) => work.kind !== first),
    ];
    held.splice(0, held.length, ...ordered);

    for (let work = held.shift(); work !== undefined; work = held.shift()) {
      work.run();
      await drainMicrotasks();
    }
    this.#frozenContexts.delete(id);
  }

  /**
   * Holds a context's timers, as Chromium holds those of a tab hidden for more than five minutes:
   * they run in a batch once a minute. Messages, events and lock grants go on as usual.
   * {@link runThrottledTimers} is the minute boundary.
   */
  throttleTimers(id: string): void {
    if (!this.#throttledContexts.has(id)) {
      this.#throttledContexts.set(id, []);
    }
  }

  /**
   * Runs the timers a throttled context has held so far, one task at a time. A timer falling due
   * meanwhile waits for the next boundary, and one cleared meanwhile does not run.
   */
  async runThrottledTimers(id: string): Promise<void> {
    const held = this.#throttledContexts.get(id);
    if (held === undefined) {
      return;
    }
    const due = new Set(held);
    for (let work = held[0]; work !== undefined && due.has(work); work = held[0]) {
      held.shift();
      work.run();
      await drainMicrotasks();
    }
  }

  /** Runs what a throttled context held, and lets its timers run on time again. */
  async stopThrottlingTimers(id: string): Promise<void> {
    await this.runThrottledTimers(id);
    this.#throttledContexts.delete(id);
  }

  /**
   * Runs `work` now, or holds it: everything while the context is frozen or still resuming, and
   * timers while its timers are throttled.
   */
  #runOrHold(
    contextId: string,
    kind: HeldWork['kind'],
    run: () => void,
    timer?: TimerHandle,
  ): void {
    const held =
      this.#frozenContexts.get(contextId) ??
      (kind === 'timer' ? this.#throttledContexts.get(contextId) : undefined);
    if (held === undefined) {
      run();
    } else {
      held.push(timer === undefined ? { kind, run } : { kind, run, timer });
    }
  }

  /** Cancels a held timer, as `clearTimeout` cancels a timer task that is queued and has not run. */
  #dropHeldTimer(contextId: string, handle: TimerHandle): void {
    for (const held of [
      this.#frozenContexts.get(contextId),
      this.#throttledContexts.get(contextId),
    ]) {
      const index = held?.findIndex((work) => work.timer === handle) ?? -1;
      if (index >= 0) {
        held?.splice(index, 1);
      }
    }
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
    this.bus.forgetContext(id);
  }

  /** @internal Used by {@link VirtualTab.kill}. */
  destroyTab(id: string, clientId: string): void {
    this.#killedContexts.add(id);
    // A frozen tab that is discarded never runs what it held.
    this.#frozenContexts.delete(id);
    this.#throttledContexts.delete(id);
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
    const serial = this.serial.forContext(contextId);
    const locks = this.locks.forContext(contextId);
    type DeviceListener = Parameters<SerialLike['addEventListener']>[1];
    /** The held versions of the device listeners, so that removing one removes its wrapper. */
    const deviceListeners = new Map<DeviceListener, DeviceListener>();

    return {
      serial: {
        getPorts: () => serial.getPorts(),
        requestPort: (options) => serial.requestPort(options),
        addEventListener: (type, listener) => {
          const held: DeviceListener = (event) => {
            this.#runOrHold(contextId, 'task', () => {
              listener(event);
            });
          };
          deviceListeners.set(listener, held);
          serial.addEventListener(type, held);
        },
        removeEventListener: (type, listener) => {
          const held = deviceListeners.get(listener);
          if (held !== undefined) {
            serial.removeEventListener(type, held);
            deviceListeners.delete(listener);
          }
        },
      },
      locks: {
        // A lock granted to a frozen context is held, and its callback runs when the context
        // resumes. The callback's own promise is returned unchanged otherwise, so that an unfrozen
        // context sees exactly the timing of the lock manager.
        request: (name, options, callback) =>
          locks.request(name, options, (lock) =>
            this.#frozenContexts.has(contextId)
              ? new Promise<void>((resume) => {
                  this.#runOrHold(contextId, 'task', resume);
                }).then(() => callback(lock))
              : callback(lock),
          ),
        ...(locks.query === undefined ? {} : { query: locks.query }),
      },
      storage: this.storage,
      createTransport: (request) =>
        this.bus.createTransport(contextId, {
          ...request,
          onMessage: (message) => {
            this.#runOrHold(contextId, 'task', () => {
              request.onMessage(message);
            });
          },
        }),
      createBroadcastChannel: (name) => this.bus.broadcastHub.create(name, contextId),
      logPayloads: this.options.logPayloads ?? false,
      // A killed tab runs no code: its timers are dropped rather than fired, as the browser
      // drops them with the tab. A frozen tab's timers fire when it resumes.
      clock: {
        now: () => this.clock.now(),
        monotonicNow: () => this.clock.monotonicNow(),
        setTimer: (callback, delayMs) => {
          const handle: TimerHandle = this.clock.setTimer(() => {
            if (!this.#killedContexts.has(contextId)) {
              this.#runOrHold(contextId, 'timer', callback, handle);
            }
          }, delayMs);
          return handle;
        },
        clearTimer: (handle) => {
          this.clock.clearTimer(handle);
          this.#dropHeldTimer(contextId, handle);
        },
      },
      // Fixed rather than seeded: backoff delays become exactly predictable, so a test can
      // assert "the third attempt happens 1000 ms later" instead of "roughly a second".
      random: () => JITTER_DRAW,
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

/**
 * Lets the microtasks already queued run, and those they queue in turn, without letting a macrotask
 * run: what a browser's microtask checkpoint after a task does.
 */
async function drainMicrotasks(): Promise<void> {
  for (let tick = 0; tick < 64; tick += 1) {
    await Promise.resolve();
  }
}

/** Runs a scenario against both transports, so neither is a second-class path. */
export const TRANSPORT_MODES: readonly TransportMode[] = ['sharedworker', 'broadcastchannel'];
