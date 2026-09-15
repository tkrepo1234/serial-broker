import { BroadcastChannelTransport } from '../../src/client/transport/broadcast-channel-transport.js';
import type { BroadcastChannelLike } from '../../src/client/transport/broadcast-channel-transport.js';
import { FallbackTransport } from '../../src/client/transport/fallback-transport.js';
import {
  SharedWorkerTransport,
  type MessagePortLike,
  type SharedWorkerLike,
} from '../../src/client/transport/shared-worker-transport.js';
import type { Transport, TransportRequest } from '../../src/client/transport/transport.js';
import type { Clock } from '../../src/core/clock.js';
import { NOOP_LOGGER } from '../../src/core/logger.js';
import type { Logger } from '../../src/core/types.js';
import { BROKER_ID, type ClientId } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { WorkerPorts, type WorkerPort } from '../../src/worker/worker-ports.js';

import type { FakeClock } from './fake-clock.js';
import type { FakeLockManager } from './fake-locks.js';

type MessageListener = (event: { readonly data: unknown }) => void;

/**
 * What crossed the bus, counted where a browser pays for it.
 *
 * `sent` is every message a context handed to the bus - handshakes included, which the transports
 * exchange below the client. `delivered` is every arrival at a context: one per
 * receiving context, each a structured clone in a browser, so a broadcast to nine peers is one
 * sent and nine delivered. Only what actually arrives is counted, not what was posted to a
 * closed port or a dead context.
 */
export interface BusMeter {
  sent: number;
  delivered: number;
}

/**
 * Delivers a message the way `postMessage` does.
 *
 * Two properties are copied deliberately. Delivery is **asynchronous**, so a test cannot
 * accidentally depend on a message arriving before the sending function returns. And the
 * payload is **structurally cloned**, so a receiver never shares a `Uint8Array` with its
 * sender - code that relied on reference identity would work in the harness and fail in a
 * browser, which is the worst possible outcome for a fake.
 */
function deliver(listener: MessageListener, message: unknown): void {
  const cloned: unknown = structuredClone(message);
  queueMicrotask(() => {
    listener({ data: cloned });
  });
}

/**
 * The worker's end of one port.
 *
 * Closing either end of a real port disentangles both: what is posted afterwards reaches nobody,
 * and neither side is told. So the worker keeps posting into a port its tab closed until the tab's
 * lock tells it the tab has gone, and the tab hears none of it.
 */
class FakeWorkerPort implements WorkerPort {
  #isOpen = true;

  /**
   * @param toOtherEnd - Receives, asynchronously and cloned, what the worker posts.
   * @param meter - Counts what arrives at the other end.
   * @param onClose - Told once, when either end closes the port.
   */
  constructor(
    private readonly toOtherEnd: (data: unknown) => void,
    private readonly meter: BusMeter,
    private readonly onClose: (port: FakeWorkerPort) => void = () => undefined,
  ) {}

  postMessage(message: unknown): void {
    if (!this.#isOpen) {
      return;
    }
    deliver((event) => {
      // Re-checked at delivery time, not only when posted: a context can vanish between the worker
      // posting and the message arriving. A browser simply drops it; a harness that delivered it
      // anyway would let a dead tab keep participating and hide the races these tests exist to find.
      if (this.#isOpen) {
        this.meter.delivered += 1;
        this.toOtherEnd(event.data);
      }
    }, message);
  }

  close(): void {
    if (!this.#isOpen) {
      return;
    }
    this.#isOpen = false;
    this.onClose(this);
  }

  get isOpen(): boolean {
    return this.#isOpen;
  }
}

/** A port to the worker held by a script that is not a tab: the test speaks for it (SECURITY.md). */
export interface ForeignWorkerPort {
  /** Posts anything, as any script of the origin can. */
  post(raw: unknown): void;
  /** Everything the worker posted to this port, in order. */
  readonly received: unknown[];
}

/**
 * An in-memory `SharedWorker` running the worker's real port handling and broker.
 *
 * `WorkerPorts` and the `Broker` under test are the production classes, not stand-ins: only the
 * plumbing around them is simulated. A routing bug, or a hole in how the worker holds a port to its
 * identity, therefore fails a test rather than surviving into a browser.
 */
export class FakeWorkerHost {
  static #nextWorkerNumber = 0;
  /** The worker's identity, and the context its Web Locks belong to. */
  readonly workerId: string;
  readonly #ports: WorkerPorts<FakeWorkerPort>;
  readonly #allPorts = new Set<FakeWorkerPort>();
  /** The participants the worker's own records say it knows. */
  readonly #participants = new Set<unknown>();
  /** What arrived before the worker held its lifetime lock, as a port not yet started keeps it. */
  #unstarted: [FakeWorkerPort, unknown][] | undefined = [];
  #isCrashed = false;

  /**
   * @param locks - The browser's lock manager: the worker holds a lock for its lifetime there, and
   *   waits on the lock of every context it hears of (ADR-0041).
   * @param logger - Receives the worker's own records, which a real worker has no way to hand to a
   *   tab. For tests that assert on them.
   * @param meter - Counts what crosses this worker's ports.
   */
  constructor(
    private readonly locks: FakeLockManager,
    logger: Logger = NOOP_LOGGER,
    private readonly meter: BusMeter = { sent: 0, delivered: 0 },
  ) {
    FakeWorkerHost.#nextWorkerNumber += 1;
    this.workerId = `worker-${String(FakeWorkerHost.#nextWorkerNumber)}`;
    this.#ports = new WorkerPorts({
      logger: {
        log: (level, message, fields) => {
          if (fields.event === 'broker.connect') {
            this.#participants.add(fields.clientId);
          } else if (fields.event === 'broker.disconnect') {
            this.#participants.delete(fields.clientId);
          }
          logger.log(level, message, fields);
        },
      },
      locks: locks.forContext(this.workerId),
      workerId: this.workerId,
    });
    // The worker script starts no port before it holds its lifetime lock.
    void this.#ports.ready.then(() => {
      const unstarted = this.#unstarted ?? [];
      this.#unstarted = undefined;
      for (const [port, raw] of unstarted) {
        this.#receive(port, raw);
      }
    });
  }

  /**
   * Participants the worker currently knows, as its records of connecting and forgetting them say:
   * the worker offers no count of its own.
   */
  get clientCount(): number {
    return this.#participants.size;
  }

  /**
   * Simulates the worker itself dying: it crashed, was ended for memory, or was terminated from
   * `chrome://inspect`.
   *
   * Its ports deliver nothing in either direction any more, its broker's state is gone, and it runs
   * no code. The browser lets go of its locks, which is all a tab learns (ADR-0041).
   */
  crash(): void {
    this.#isCrashed = true;
    for (const port of this.#allPorts) {
      port.close();
    }
    this.#allPorts.clear();
    this.#participants.clear();
    this.#unstarted = undefined;
    this.#ports.dispose();
    this.locks.killContext(this.workerId);
  }

  /**
   * Connects a new port, as `new SharedWorker` does. The worker learns who is behind it only from
   * what arrives on it.
   *
   * @param toTab - Receives what the worker posts into the port.
   * @returns The worker's end, to hand what the tab posts to {@link FakeWorkerHost.send}.
   */
  connect(toTab: (data: unknown) => void): FakeWorkerPort {
    // A closed port is let go of, as a browser lets go of the port of a context that is gone: a
    // host that kept every port ever connected would hold every dead tab's client with it, and
    // a measurement of what the library keeps would be measuring the harness.
    const port = new FakeWorkerPort(toTab, this.meter, (closed) => {
      this.#allPorts.delete(closed);
    });
    if (this.#isCrashed) {
      port.close();
    } else {
      this.#allPorts.add(port);
    }
    return port;
  }

  /** Hands the worker a message that arrived on `port`, as the worker's `message` listener does. */
  send(port: FakeWorkerPort, raw: unknown): void {
    if (this.#isCrashed || !port.isOpen) {
      return;
    }
    this.meter.sent += 1;
    if (this.#unstarted !== undefined) {
      this.#unstarted.push([port, raw]);
      return;
    }
    this.#receive(port, raw);
  }

  #receive(port: FakeWorkerPort, raw: unknown): void {
    if (!this.#isCrashed && port.isOpen) {
      this.#ports.receive(port, raw);
    }
  }

  /** Connects a port for a script that is not a tab, which the test then speaks for. */
  connectForeign(): ForeignWorkerPort {
    const received: unknown[] = [];
    const port = this.connect((data) => received.push(data));
    return {
      received,
      post: (raw) => {
        this.send(port, structuredClone(raw));
      },
    };
  }
}

/** An in-memory `BroadcastChannel` hub: every channel of a name hears every other. */
export class FakeBroadcastHub {
  readonly #channels = new Map<string, Set<{ id: string; listeners: MessageListener[] }>>();

  /** @param meter - Counts what is posted and what arrives. */
  constructor(private readonly meter: BusMeter = { sent: 0, delivered: 0 }) {}

  create(name: string, contextId: string): BroadcastChannelLike {
    // Every listener registered on a channel hears each message, as on the platform: keeping only
    // the last one would hide a listener registered twice, or one replaced by mistake.
    const entry = { id: contextId, listeners: [] as MessageListener[] };
    const set = this.#channels.get(name) ?? new Set();
    set.add(entry);
    this.#channels.set(name, set);

    return {
      postMessage: (message) => {
        this.meter.sent += 1;
        for (const peer of set) {
          // A real BroadcastChannel never delivers to the context that posted.
          if (peer.id === contextId) {
            continue;
          }
          // Membership is re-checked at delivery time: a context can be destroyed between a
          // message being posted and it arriving, and a browser drops it rather than waking
          // the dead. Delivering it anyway would let a killed tab keep writing to the device.
          deliver((event) => {
            if (set.has(peer)) {
              this.meter.delivered += 1;
              for (const listener of peer.listeners) {
                listener(event);
              }
            }
          }, message);
        }
      },
      close: () => {
        set.delete(entry);
      },
      addEventListener: (type: string, listener: unknown) => {
        if (type === 'message') {
          entry.listeners.push(listener as MessageListener);
        }
      },
    } as BroadcastChannelLike;
  }

  /**
   * Posts a message as some context that is not part of this test's set of tabs.
   *
   * Used to simulate traffic from an older build of the library, or from an unrelated script
   * on the same origin that happens to use the same channel name.
   */
  injectForeign(name: string, raw: unknown): void {
    for (const peer of this.#channels.get(name) ?? []) {
      // Cloned, as everything crossing a channel is: a test cannot hand over what a browser could
      // not send.
      const data: unknown = structuredClone(raw);
      queueMicrotask(() => {
        for (const listener of peer.listeners) {
          listener({ data });
        }
      });
    }
  }

  /** Removes a context's channels without the polite `close()`, as a killed tab does. */
  killContext(contextId: string): void {
    for (const set of this.#channels.values()) {
      for (const entry of [...set]) {
        if (entry.id === contextId) {
          set.delete(entry);
        }
      }
    }
  }
}

/** Which transport a harness run exercises. Every scenario runs against both. */
export type TransportMode = 'sharedworker' | 'broadcastchannel';

/**
 * What the browser runs when a tab starts the `SharedWorker`.
 *
 * - `'loads'`: this build's worker script, hosting the real broker.
 * - `'fails'`: nothing, until {@link FakeBus.failWorkerScripts} delivers the browser's error
 *   event, as for a script that answers 404.
 * - `'other-version'`: a worker script of an earlier protocol version, such as a copied worker
 *   file left over from an older release. It drops everything a tab says, and keeps only the
 *   frozen part of the handshake: it answers `hello` with a welcome in its own version (ADR-0024).
 */
export type WorkerScript = 'loads' | 'fails' | 'other-version';

/**
 * The message bus shared by every simulated context in a test.
 *
 * Holds both implementations so the same scenario can be run against each without the test
 * knowing which is in play - which is the only way to keep the fallback a first-class path
 * rather than an untested branch (ADR-0007).
 */
export class FakeBus {
  /** What crossed the bus so far, on either transport and through every worker started. */
  readonly meter: BusMeter = { sent: 0, delivered: 0 };
  readonly broadcastHub = new FakeBroadcastHub(this.meter);

  #workerHost: FakeWorkerHost;
  #workerScript: WorkerScript;
  readonly #workerFailures: ((event: unknown) => void)[] = [];
  /** Contexts that died: nothing they send reaches the worker any more, and their timers stop. */
  readonly #killed = new Set<string>();
  /** The worker's end of every port each context started, so that killing the context stops them. */
  readonly #workerEnds = new Map<string, FakeWorkerPort[]>();

  /**
   * @param mode - Which transport the tabs start on.
   * @param workerScript - In `sharedworker` mode, which worker script the browser runs.
   */
  constructor(
    readonly mode: TransportMode,
    workerScript: WorkerScript = 'loads',
    /** Time for the bus: the deadline of the worker's handshake. */
    readonly clock: FakeClock,
    /** The browser's locks, which the workers hold and wait on (ADR-0041). */
    readonly locks: FakeLockManager,
  ) {
    this.#workerScript = workerScript;
    this.#workerHost = new FakeWorkerHost(locks, NOOP_LOGGER, this.meter);
  }

  /** In `sharedworker` mode, the script the browser runs for a worker started now. */
  get workerScript(): WorkerScript {
    return this.#workerScript;
  }

  /** The worker a tab reaches if it starts one now: the first, or the one since the last crash. */
  get workerHost(): FakeWorkerHost {
    return this.#workerHost;
  }

  /** Reports every worker script that did not load, as the browser's `error` event does. */
  failWorkerScripts(): void {
    for (const fail of this.#workerFailures.splice(0)) {
      fail({ type: 'error' });
    }
  }

  /**
   * Simulates the worker dying while tabs are connected to it.
   *
   * As in a browser, the tabs are not told: their ports simply go dead. The next tab to start the
   * worker - one opened later, or one whose wait on the dead one's lock ended (ADR-0041) - starts a new one,
   * which knows nothing of the tabs that were connected to the old.
   *
   * @param restartsAs - The script every worker started from now on runs. A different one is what
   *   an open tab meets when the application was deployed again under the same worker URL.
   */
  crashWorker(restartsAs: WorkerScript = this.#workerScript): void {
    this.#workerHost.crash();
    this.#workerHost = new FakeWorkerHost(this.locks, NOOP_LOGGER, this.meter);
    this.#workerScript = restartsAs;
  }

  /** Builds the transport a simulated context should use. */
  createTransport(contextId: string, request: TransportRequest): Transport {
    return this.mode === 'sharedworker'
      ? this.#createWorkerTransport(contextId, request)
      : new BroadcastChannelTransport(request, (name) => this.broadcastHub.create(name, contextId));
  }

  /**
   * Simulates a context vanishing without cleanup.
   *
   * @param _clientId - Its identity on the bus. Unused: the worker learns identities only from what
   *   arrives on a port, so killing the context's ports is what silences it.
   */
  killContext(contextId: string, _clientId?: ClientId): void {
    // A real worker is never told that a tab died: the port simply stops, in both directions, and
    // the worker learns of it only when the browser lets go of the tab's lock (ADR-0041).
    this.#killed.add(contextId);
    for (const port of this.#workerEnds.get(contextId) ?? []) {
      port.close();
    }
    // Nothing of a dead context's is kept: its ports are closed, and with them goes the last
    // reference the bus held to its client.
    this.#workerEnds.delete(contextId);
    this.broadcastHub.killContext(contextId);
  }

  /**
   * Lets go of a context that closed after cleaning up, as the browser lets go of a closed tab.
   *
   * Its ports to the worker are closed - the transport let go of its lock first, so the worker has
   * learnt it has gone - and dropped. Unlike {@link FakeBus.killContext} nothing is cut off:
   * a closed context has nothing left to send.
   */
  forgetContext(contextId: string): void {
    for (const port of this.#workerEnds.get(contextId) ?? []) {
      port.close();
    }
    this.#workerEnds.delete(contextId);
  }

  #createWorkerTransport(contextId: string, tabRequest: TransportRequest): Transport {
    // The handshake deadline runs on the bus's own clock, so that tests asserting on the library's
    // timers are not disturbed by it.
    const request: TransportRequest = { ...tabRequest, clock: this.#clockFor(contextId) };

    // Wrapped exactly as the browser environment wraps it, so every scenario in this mode also
    // runs through the path that waits for the broker's welcome (ADR-0007).
    return new FallbackTransport(
      request,
      (workerRequest, startup) =>
        new SharedWorkerTransport(
          workerRequest,
          () => this.#startWorker(contextId, workerRequest.clientId),
          'fake://worker',
          startup,
        ),
      (fallbackRequest) =>
        new BroadcastChannelTransport(fallbackRequest, (name) =>
          this.broadcastHub.create(name, contextId),
        ),
    );
  }

  /** The bus clock as one context sees it: a killed context runs no code, so its timers stop. */
  #clockFor(contextId: string): Clock {
    return {
      now: () => this.clock.now(),
      monotonicNow: () => this.clock.monotonicNow(),
      setTimer: (callback, delayMs) =>
        this.clock.setTimer(() => {
          if (!this.#killed.has(contextId)) {
            callback();
          }
        }, delayMs),
      clearTimer: (handle) => {
        this.clock.clearTimer(handle);
      },
    };
  }

  /**
   * What `new SharedWorker` hands a tab: a new port, to the worker running now.
   *
   * Called for every worker a tab starts, so a tab that gave up on a crashed worker reaches the one
   * started since, and its old port stays connected to the dead one.
   */
  #startWorker(contextId: string, clientId: ClientId): SharedWorkerLike {
    const host = this.#workerHost;
    // Read once: a worker keeps the script it started with.
    const script = this.#workerScript;
    const loads = script === 'loads';
    /** The tab's end of the port. */
    let tabListener: MessageListener | undefined;
    /**
     * A port whose listener is added with `addEventListener` delivers nothing until `start()`. The
     * fake keeps to that, so a transport that forgets the call fails here and not only in a browser.
     * What arrives before is kept, as a port queues it.
     */
    let isStarted = false;
    const inbox: unknown[] = [];
    const flushInbox = (): void => {
      if (isStarted && tabListener !== undefined) {
        for (const data of inbox.splice(0)) {
          tabListener({ data });
        }
      }
    };
    const toTab = (data: unknown): void => {
      inbox.push(data);
      flushInbox();
    };

    const workerEnd = loads ? host.connect(toTab) : undefined;
    if (workerEnd !== undefined) {
      this.#workerEnds.set(contextId, [...(this.#workerEnds.get(contextId) ?? []), workerEnd]);
    }

    const port: MessagePortLike = {
      postMessage: (message) => {
        if (this.#killed.has(contextId)) {
          return;
        }
        if (workerEnd !== undefined) {
          host.send(workerEnd, structuredClone(message));
          return;
        }
        // A port to a worker whose script never ran accepts messages and delivers none. A worker of
        // another version drops them too, but answers the frozen handshake (ADR-0024).
        if (
          script === 'other-version' &&
          isStarted &&
          tabListener !== undefined &&
          (message as { readonly type?: unknown }).type === 'hello'
        ) {
          deliver(tabListener, {
            type: 'welcome',
            v: PROTOCOL_VERSION - 1,
            from: BROKER_ID,
            to: clientId,
          });
        }
      },
      start: () => {
        if (isStarted) {
          return;
        }
        isStarted = true;
        flushInbox();
      },
      close: () => {
        // The worker is not told; it only stops reaching the tab.
        workerEnd?.close();
      },
      addEventListener: (type: string, listener: unknown) => {
        if (type !== 'message') {
          return;
        }
        tabListener = listener as MessageListener;
        flushInbox();
      },
    } as MessagePortLike;

    return {
      port,
      addEventListener: (_type, listener) => {
        if (!loads) {
          this.#workerFailures.push(listener);
        }
      },
    };
  }
}
