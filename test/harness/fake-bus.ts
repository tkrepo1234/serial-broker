import { BroadcastChannelTransport } from '../../src/client/transport/broadcast-channel-transport.js';
import type { BroadcastChannelLike } from '../../src/client/transport/broadcast-channel-transport.js';
import { FallbackTransport } from '../../src/client/transport/fallback-transport.js';
import {
  SharedWorkerTransport,
  type MessagePortLike,
  type SharedWorkerLike,
} from '../../src/client/transport/shared-worker-transport.js';
import type { Transport, TransportRequest } from '../../src/client/transport/transport.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { decodeMessage } from '../../src/protocol/decode.js';
import { SILENT_PARTICIPANT_TIMEOUT_MS, SWEEP_INTERVAL_MS } from '../../src/protocol/heartbeat.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
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

  #scheduleSweep(): void {
    this.clock.setTimer(() => {
      this.#broker.forgetSilent(SILENT_PARTICIPANT_TIMEOUT_MS);
      this.#scheduleSweep();
    }, SWEEP_INTERVAL_MS);
  }

  /** Connects a context's port. */
  connect(clientId: ClientId, listener: MessageListener): void {
    this.#ports.set(clientId, listener);
    this.#broker.handleConnect(clientId);
  }

  /** Simulates a context vanishing: its port is gone and the broker is told. */
  disconnect(clientId: ClientId): void {
    this.#ports.delete(clientId);
    this.#broker.handleDisconnect(clientId);
  }

  /** Feeds a message from a context into the broker, validating it first as the worker does. */
  send(clientId: ClientId, raw: unknown): void {
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
  readonly #channels = new Map<string, Set<{ id: string; listener: MessageListener }>>();

  create(name: string, contextId: string): BroadcastChannelLike {
    const entry = { id: contextId, listener: (() => undefined) as MessageListener };
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
              peer.listener(event);
            }
          }, message);
        }
      },
      close: () => {
        set.delete(entry);
      },
      addEventListener: (type: string, listener: unknown) => {
        if (type === 'message') {
          entry.listener = listener as MessageListener;
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
      queueMicrotask(() => peer.listener({ data: raw }));
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
 * The message bus shared by every simulated context in a test.
 *
 * Holds both implementations so the same scenario can be run against each without the test
 * knowing which is in play - which is the only way to keep the fallback a first-class path
 * rather than an untested branch (ADR-0007).
 */
export class FakeBus {
  readonly workerHost: FakeWorkerHost;
  readonly broadcastHub = new FakeBroadcastHub();

  readonly #workerFailures: ((event: unknown) => void)[] = [];
  /** Contexts that died: nothing they send reaches the worker any more. */
  readonly #killed = new Set<string>();

  /**
   * @param mode - Which transport the tabs start on.
   * @param workerScript - In `sharedworker` mode, whether the worker script loads. With
   *   `'fails'`, nothing a tab sends reaches the broker until {@link failWorkerScripts} delivers
   *   the browser's error event.
   */
  constructor(
    readonly mode: TransportMode,
    readonly workerScript: 'loads' | 'fails' = 'loads',
    /** Time for the bus: the heartbeats tabs send and the worker's sweep. */
    readonly clock: FakeClock,
  ) {
    this.workerHost = new FakeWorkerHost(clock);
  }

  /** Reports every worker script that did not load, as the browser's `error` event does. */
  failWorkerScripts(): void {
    for (const fail of this.#workerFailures.splice(0)) {
      fail({ type: 'error' });
    }
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
    this.workerHost.silence(clientId);
    this.broadcastHub.killContext(contextId);
  }

  #createWorkerTransport(contextId: string, tabRequest: TransportRequest): Transport {
    // Heartbeats run on the bus's own clock, so that tests asserting on the library's timers are
    // not disturbed by them.
    const request: TransportRequest = { ...tabRequest, clock: this.clock };
    const clientId = request.clientId;
    const loads = this.workerScript === 'loads';

    const port: MessagePortLike = {
      postMessage: (message) => {
        // A port to a worker whose script never ran accepts messages and delivers none.
        if (loads && !this.#killed.has(contextId)) {
          this.workerHost.send(clientId, structuredClone(message));
        }
      },
      start: () => {
        /* nothing to do: this fake delivers as soon as a listener is registered */
      },
      close: () => {
        this.workerHost.disconnect(clientId);
      },
      addEventListener: (type: string, listener: unknown) => {
        if (type === 'message' && loads) {
          this.workerHost.connect(clientId, listener as MessageListener);
        }
      },
    } as MessagePortLike;

    const worker: SharedWorkerLike = {
      port,
      addEventListener: (_type, listener) => {
        if (!loads) {
          this.#workerFailures.push(listener);
        }
      },
    };

    // Wrapped exactly as the browser environment wraps it, so every scenario in this mode also
    // runs through the path that waits for the broker's welcome (ADR-0007).
    return new FallbackTransport(
      request,
      (workerRequest, startup) =>
        new SharedWorkerTransport(workerRequest, () => worker, 'fake://worker', startup),
      (fallbackRequest) =>
        new BroadcastChannelTransport(fallbackRequest, (name) =>
          this.broadcastHub.create(name, contextId),
        ),
    );
  }
}
