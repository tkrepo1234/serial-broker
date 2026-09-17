import type { ProtocolMessage } from '../../protocol/messages.js';

import type { WorkerLoadFailure, WorkerStartup } from './shared-worker-transport.js';
import type { Transport, TransportRequest } from './transport.js';

/** What the log says on falling back, for each way of finding out that the worker is unusable. */
const FALLBACK_LOG_MESSAGES: Readonly<Record<WorkerLoadFailure, string>> = {
  'worker-script-failed': 'the SharedWorker script did not load; using BroadcastChannel',
  'worker-other-protocol-version':
    'the SharedWorker script runs another protocol version; using BroadcastChannel',
  'worker-not-answering': 'the SharedWorker never answered; using BroadcastChannel',
};

/**
 * A `SharedWorker` transport that moves to `BroadcastChannel` when the worker script turns out
 * not to load.
 *
 * Constructing a `SharedWorker` succeeds even when its script URL answers 404: the browser
 * reports the failure afterwards, as an `error` event. By then the tab has already announced
 * itself, attached its configurations, perhaps claimed a port - all into a port that delivers
 * nothing. Falling back at construction alone would leave that tab cut off from every other
 * (ADR-0006).
 *
 * So until the broker's `welcome` proves the script runs, the transport can still move. When it
 * does, nothing it sent reached anyone, and nothing is sent again: the new bus is told what this
 * context takes part in, and the client states again what the others need to know, as it does after
 * reaching a new worker (ADR-0041). Who holds the port is the Web Locks' to say, not a message's, so
 * no term can be left waiting on a word that went into the unusable worker: a tab that knows of a
 * term has heard of it on the bus the term's holder is on. Traffic sent in between is lost.
 */
export class FallbackTransport implements Transport {
  readonly clientId;

  readonly #request: TransportRequest;
  readonly #createFallback: (request: TransportRequest) => Transport;
  readonly #attached = new Set<string>();
  #active: Transport;
  /** The worker answered, or the fallback took over: nothing moves any more. */
  #isSettled = false;
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
        this.#isSettled = true;
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
    this.#active.send(message);
  }

  /** {@inheritDoc Transport.attach} */
  attach(configName: string): void {
    this.#attached.add(configName);
    this.#active.attach(configName);
  }

  /** {@inheritDoc Transport.detach} */
  detach(configName: string): void {
    this.#attached.delete(configName);
    this.#active.detach(configName);
  }

  /** {@inheritDoc Transport.close} */
  close(): void {
    this.#isClosed = true;
    this.#active.close();
  }

  #fallBack(event: unknown, reason: WorkerLoadFailure): void {
    if (this.#isClosed) {
      // Whoever closed the transport has stopped listening, and nothing is left to move. Reachable
      // from inside the worker transport's own report: a listener that hears the worker's other
      // protocol version can close the bus before the worker transport goes on to fall back.
      return;
    }
    if (this.#isSettled) {
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

    this.#isSettled = true;
    const failed = this.#active;
    this.#active = fallback;
    failed.close();
    for (const configName of this.#attached) {
      fallback.attach(configName);
    }

    this.#request.logger.warn(FALLBACK_LOG_MESSAGES[reason], {
      event: 'environment.transport-fallback',
      reason,
    });
    this.#request.onReconnected?.();
  }
}
