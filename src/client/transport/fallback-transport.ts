import type { ProtocolMessage } from '../../protocol/messages.js';

import type { WorkerLoadFailure, WorkerStartup } from './shared-worker-transport.js';
import type { Transport, TransportRequest } from './transport.js';

/**
 * Most traffic messages - data received and data sent - kept for replay while the worker has
 * not answered.
 *
 * A worker script normally answers within milliseconds, and a missing one, or one of another
 * protocol version, is found out about as fast. One that says nothing at all is given up on once
 * `MAX_UNANSWERED_HEARTBEATS` heartbeats went unanswered - under a minute in a visible tab, a few in
 * a hidden one (ADR-0021) - so the record is kept for that long at most. In that time only traffic
 * arrives in quantity, and this bound trades its completeness for bounded memory. Every other
 * message is always kept: dropping an ownership claim or a write result would leave other tabs
 * waiting, and the rest of what a tab says in that time is bounded by the time itself.
 */
export const MAX_REPLAYED_MESSAGES = 1000;

/** What the log says on falling back, for each way of finding out that the worker is unusable. */
const FALLBACK_LOG_MESSAGES: Readonly<Record<WorkerLoadFailure, string>> = {
  'worker-script-failed': 'the SharedWorker script did not load; using BroadcastChannel',
  'worker-other-protocol-version':
    'the SharedWorker script runs another protocol version; using BroadcastChannel',
  'worker-not-answering': 'the SharedWorker never answered; using BroadcastChannel',
};

/** Something the application's side of the bus asked for, in the order it asked. */
type Operation =
  | { readonly kind: 'send'; readonly message: ProtocolMessage }
  | { readonly kind: 'attach' | 'detach'; readonly configName: string };

/**
 * A `SharedWorker` transport that moves to `BroadcastChannel` when the worker script turns out
 * not to load.
 *
 * Constructing a `SharedWorker` succeeds even when its script URL answers 404: the browser
 * reports the failure afterwards, as an `error` event. By then the tab has already announced
 * itself, attached its configurations, perhaps claimed a port - all into a port that delivers
 * nothing. Falling back at construction alone would leave that tab cut off from every other
 * (ADR-0007).
 *
 * So until the broker's `welcome` proves the script runs, everything asked of the bus is kept.
 * If the script fails first, none of it reached anyone, and replaying it over a
 * `BroadcastChannel` delivers each message exactly once, in the order it was sent - except traffic
 * beyond {@link MAX_REPLAYED_MESSAGES}, which is counted and dropped. Once the
 * welcome arrives the record is dropped, and a later worker error is an ordinary transport error.
 */
export class FallbackTransport implements Transport {
  readonly clientId;

  readonly #request: TransportRequest;
  readonly #createFallback: (request: TransportRequest) => Transport;
  #active: Transport;
  /** `undefined` once the outcome is known: the worker answered, or the fallback took over. */
  #pending: Operation[] | undefined = [];
  #keptTraffic = 0;
  #droppedMessages = 0;
  #isClosed = false;

  /**
   * @param request - What the transport delivers to.
   * @param createWorkerTransport - Builds the `SharedWorker` transport, wired to report whether
   *   its script started.
   * @param createFallback - Builds the `BroadcastChannel` transport, only if it is needed.
   */
  constructor(
    request: TransportRequest,
    createWorkerTransport: (request: TransportRequest, startup: WorkerStartup) => Transport,
    createFallback: (request: TransportRequest) => Transport,
  ) {
    this.clientId = request.clientId;
    this.#request = request;
    this.#createFallback = createFallback;
    this.#active = createWorkerTransport(request, {
      onReady: () => {
        this.#pending = undefined;
      },
      onLoadFailed: (event, reason) => {
        this.#fallBack(event, reason);
      },
    });
  }

  /** {@inheritDoc Transport.kind} */
  get kind(): Transport['kind'] {
    return this.#active.kind;
  }

  /** {@inheritDoc Transport.send} */
  send(message: ProtocolMessage): void {
    this.#keep({ kind: 'send', message });
    this.#active.send(message);
  }

  /** {@inheritDoc Transport.attach} */
  attach(configName: string): void {
    this.#keep({ kind: 'attach', configName });
    this.#active.attach(configName);
  }

  /** {@inheritDoc Transport.detach} */
  detach(configName: string): void {
    this.#keep({ kind: 'detach', configName });
    this.#active.detach(configName);
  }

  /** {@inheritDoc Transport.close} */
  close(): void {
    this.#isClosed = true;
    this.#pending = undefined;
    this.#active.close();
  }

  #keep(operation: Operation): void {
    const pending = this.#pending;
    if (pending === undefined) {
      return;
    }
    if (operation.kind === 'send' && isTraffic(operation.message)) {
      if (this.#keptTraffic >= MAX_REPLAYED_MESSAGES) {
        this.#droppedMessages += 1;
        return;
      }
      this.#keptTraffic += 1;
    }
    pending.push(operation);
  }

  #fallBack(event: unknown, reason: WorkerLoadFailure): void {
    if (this.#isClosed) {
      // Whoever closed the transport has stopped listening, and nothing is left to move. Reachable
      // from inside the worker transport's own report: a listener that hears the worker's other
      // protocol version can close the bus before the worker transport goes on to fall back.
      return;
    }
    const pending = this.#pending;
    if (pending === undefined) {
      this.#request.onTransportError(event);
      return;
    }

    let fallback: Transport;
    try {
      fallback = this.#createFallback(this.#request);
    } catch {
      // Nothing to fall back to. The failure worth reporting is the worker's, not this one.
      this.#request.onTransportError(event);
      return;
    }

    this.#pending = undefined;
    const failed = this.#active;
    this.#active = fallback;
    failed.close();

    for (const operation of pending) {
      switch (operation.kind) {
        case 'send':
          fallback.send(operation.message);
          break;
        case 'attach':
          fallback.attach(operation.configName);
          break;
        case 'detach':
          fallback.detach(operation.configName);
          break;
      }
    }

    this.#request.logger.warn(FALLBACK_LOG_MESSAGES[reason], {
      event: 'environment.transport-fallback',
      reason,
      replayedMessages: pending.filter((operation) => operation.kind === 'send').length,
      droppedMessages: this.#droppedMessages,
    });
  }
}

/** Data the device sent or was sent: plentiful, and the only messages the replay may drop. */
function isTraffic(message: ProtocolMessage): boolean {
  return message.type === 'data-received' || message.type === 'data-sent';
}
