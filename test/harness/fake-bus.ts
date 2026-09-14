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
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { decodeMessage } from '../../src/protocol/decode.js';
import { SILENT_PARTICIPANT_TIMEOUT_MS, SWEEP_INTERVAL_MS } from '../../src/protocol/heartbeat.js';
import { BROKER_ID, type ClientId, type ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { Broker } from '../../src/worker/broker.js';

import type { FakeClock } from './fake-clock.js';

type MessageListener = (event: { readonly data: unknown }) => void;

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
 * An in-memory `SharedWorker` hosting the real broker.
 *
 * The broker under test is the production class, not a stand-in: only the plumbing around it
 * is simulated. A routing bug therefore fails a test rather than surviving into a browser.
 */
export class FakeWorkerHost {
  readonly #ports = new Map<ClientId, MessageListener>();
  readonly #broker: Broker;
  #isCrashed = false;
  /** Every message the broker received, for assertions about protocol traffic. */
  readonly received: ProtocolMessage[] = [];

  constructor(private readonly clock: FakeClock) {
    this.#broker = new Broker({
      deliver: (clientId, message) => {
        const listener = this.#ports.get(clientId);
        if (listener === undefined) {
          return;
        }
        // Re-checked at delivery time, not only at routing time: a context can vanish between
        // the broker deciding where a message goes and the message arriving. A browser simply
        // drops it; a harness that delivered it anyway would let a dead tab keep participating
        // and would hide exactly the races these tests exist to find.
        deliver((event) => {
          if (this.#ports.get(clientId) === listener) {
            listener(event);
          }
        }, message);
      },
      logger: new ScopedLogger(NOOP_LOGGER, {}),
      now: () => clock.now(),
    });
    this.#scheduleSweep();
  }

  /** Participants the broker currently knows. */
  get clientCount(): number {
    return this.#broker.clientCount;
  }

  /**
   * Simulates a context dying: its port delivers nothing any more, and the broker is not told.
   *
   * A real worker never learns that a tab died. It forgets the tab only once its heartbeats have
   * stopped for long enough (ADR-0021), which is what the sweep here does too.
   */
  silence(clientId: ClientId): void {
    this.#ports.delete(clientId);
  }

  /**
   * Simulates the worker itself dying: it crashed, was ended for memory, or was terminated from
   * `chrome://inspect`.
   *
   * Nobody is told. Its ports deliver nothing in either direction any more, its broker's state is
   * gone, and it runs no code - not even its sweep.
   */
  crash(): void {
    this.#isCrashed = true;
    this.#ports.clear();
    this.#broker.dispose();
  }

  #scheduleSweep(): void {
    this.clock.setTimer(() => {
      if (this.#isCrashed) {
        return;
      }
      this.#broker.forgetSilent(SILENT_PARTICIPANT_TIMEOUT_MS);
      this.#scheduleSweep();
    }, SWEEP_INTERVAL_MS);
  }

  /** Connects a context's port. */
  connect(clientId: ClientId, listener: MessageListener): void {
    if (this.#isCrashed) {
      return;
    }
    this.#ports.set(clientId, listener);
    this.#broker.handleConnect(clientId);
  }

  /**
   * Simulates a context closing its port: the port is gone and the broker is told.
   *
   * Only the port given: a context that has already connected again on another port keeps that
   * one, whichever of the two it closes first.
   */
  disconnect(clientId: ClientId, listener: MessageListener): void {
    if (this.#ports.get(clientId) !== listener) {
      return;
    }
    this.#ports.delete(clientId);
    this.#broker.handleDisconnect(clientId);
  }

  /** Feeds a message from a context into the broker, validating it first as the worker does. */
  send(clientId: ClientId, raw: unknown): void {
    if (this.#isCrashed) {
      return;
    }
    const result = decodeMessage(raw);
    if (!result.ok) {
      return;
    }
    this.received.push(result.message);
    this.#broker.handleMessage(clientId, result.message);
  }
}

/** An in-memory `BroadcastChannel` hub: every channel of a name hears every other. */
export class FakeBroadcastHub {
  readonly #channels = new Map<string, Set<{ id: string; listeners: MessageListener[] }>>();

  create(name: string, contextId: string): BroadcastChannelLike {
    // Every listener registered on a channel hears each message, as on the platform: keeping only
    // the last one would hide a listener registered twice, or one replaced by mistake.
    const entry = { id: contextId, listeners: [] as MessageListener[] };
    const set = this.#channels.get(name) ?? new Set();
    set.add(entry);
    this.#channels.set(name, set);

    return {
      postMessage: (message) => {
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
  readonly broadcastHub = new FakeBroadcastHub();

  #workerHost: FakeWorkerHost;
  #workerScript: WorkerScript;
  readonly #workerFailures: ((event: unknown) => void)[] = [];
  /** Contexts that died: nothing they send reaches the worker any more, and their timers stop. */
  readonly #killed = new Set<string>();

  /**
   * @param mode - Which transport the tabs start on.
   * @param workerScript - In `sharedworker` mode, which worker script the browser runs.
   */
  constructor(
    readonly mode: TransportMode,
    workerScript: WorkerScript = 'loads',
    /** Time for the bus: the heartbeats tabs send and the worker's sweep. */
    readonly clock: FakeClock,
  ) {
    this.#workerScript = workerScript;
    this.#workerHost = new FakeWorkerHost(clock);
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
   * worker - one opened later, or one that gave up on the dead one (ADR-0021) - starts a new one,
   * which knows nothing of the tabs that were connected to the old.
   *
   * @param restartsAs - The script every worker started from now on runs. A different one is what
   *   an open tab meets when the application was deployed again under the same worker URL.
   */
  crashWorker(restartsAs: WorkerScript = this.#workerScript): void {
    this.#workerHost.crash();
    this.#workerHost = new FakeWorkerHost(this.clock);
    this.#workerScript = restartsAs;
  }

  /** Builds the transport a simulated context should use. */
  createTransport(contextId: string, request: TransportRequest): Transport {
    return this.mode === 'sharedworker'
      ? this.#createWorkerTransport(contextId, request)
      : new BroadcastChannelTransport(request, (name) => this.broadcastHub.create(name, contextId));
  }

  /** Simulates a context vanishing without cleanup. */
  killContext(contextId: string, clientId: ClientId): void {
    // A real worker is never told that a tab died: the port simply stops, in both directions, and
    // the broker learns of it only when the tab's heartbeats stop arriving (ADR-0021).
    this.#killed.add(contextId);
    this.#workerHost.silence(clientId);
    this.broadcastHub.killContext(contextId);
  }

  #createWorkerTransport(contextId: string, tabRequest: TransportRequest): Transport {
    // Heartbeats run on the bus's own clock, so that tests asserting on the library's timers are
    // not disturbed by them.
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
     */
    let isStarted = false;
    const connectWhenReady = (): void => {
      if (loads && isStarted && tabListener !== undefined) {
        host.connect(clientId, tabListener);
      }
    };

    const port: MessagePortLike = {
      postMessage: (message) => {
        if (this.#killed.has(contextId)) {
          return;
        }
        if (loads) {
          host.send(clientId, structuredClone(message));
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
        connectWhenReady();
      },
      close: () => {
        if (loads && tabListener !== undefined) {
          host.disconnect(clientId, tabListener);
        }
      },
      addEventListener: (type: string, listener: unknown) => {
        if (type !== 'message') {
          return;
        }
        tabListener = listener as MessageListener;
        connectWhenReady();
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
