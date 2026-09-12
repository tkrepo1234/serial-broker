import { DisposalStack } from '../../core/disposable.js';
import { decodeMessage } from '../../protocol/decode.js';
import type { ProtocolMessage } from '../../protocol/messages.js';
import { brokerChannelName, PROTOCOL_VERSION } from '../../protocol/version.js';

import type { Transport, TransportRequest } from './transport.js';

/** The `SharedWorker` surface this transport uses. Narrowed so a fake stays small. */
export interface SharedWorkerLike {
  readonly port: MessagePortLike;
  /** Fires when the worker script itself fails to load or throws during evaluation. */
  addEventListener(type: 'error', listener: (event: unknown) => void): void;
}

/** The `MessagePort` surface this transport uses. */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'messageerror', listener: (event: unknown) => void): void;
}

/** Constructs a `SharedWorker`. Injected so the harness can substitute one (ADR-0014). */
export type SharedWorkerFactory = (url: string | URL, name: string) => SharedWorkerLike;

/**
 * Delivers messages through a `SharedWorker` hosting the broker.
 *
 * The transport itself is thin: it owns one `MessagePort`, validates everything arriving on
 * it, and forwards what survives. Routing is the broker's job (ADR-0006).
 *
 * `attach`, `detach` and `setOwnership` become messages rather than local state, because the
 * broker is the thing that needs to know.
 */
export class SharedWorkerTransport implements Transport {
  readonly kind = 'sharedworker' as const;
  readonly clientId;

  readonly #port: MessagePortLike;
  readonly #disposal = new DisposalStack();
  readonly #request: TransportRequest;

  constructor(request: TransportRequest, createWorker: SharedWorkerFactory, url: string | URL) {
    this.clientId = request.clientId;
    this.#request = request;

    const worker = createWorker(url, brokerChannelName());
    this.#port = worker.port;

    worker.addEventListener('error', (event) => {
      // A worker that fails to evaluate leaves a port that silently never delivers anything.
      // Surfacing it here is what lets the client fall back to BroadcastChannel instead of
      // waiting forever for a connection that cannot happen.
      request.onTransportError(event);
    });

    this.#port.addEventListener('message', (event: { readonly data: unknown }) => {
      this.#receive(event.data);
    });

    this.#port.addEventListener('messageerror', (event: unknown) => {
      // Structured cloning failed on the way in. The message is unrecoverable; reporting it
      // is all that can be done, and dropping it silently would hide a real bug.
      request.onTransportError(event);
    });

    this.#port.start();
    this.#disposal.add(() => {
      this.#port.close();
    });

    this.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      to: 'all',
    });
  }

  /** {@inheritDoc Transport.send} */
  send(message: ProtocolMessage): void {
    if (this.#disposal.isDisposed) {
      return;
    }

    try {
      this.#port.postMessage(message);
    } catch (error) {
      // `postMessage` throws on a closed port and on a payload that cannot be cloned. The
      // first is a race with teardown and is uninteresting; the second is a bug worth seeing.
      this.#request.onTransportError(error);
    }
  }

  /** {@inheritDoc Transport.attach} */
  attach(configName: string): void {
    this.send({
      type: 'attach',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      to: 'all',
      configName,
    });
  }

  /** {@inheritDoc Transport.detach} */
  detach(configName: string): void {
    this.send({
      type: 'detach',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      to: 'all',
      configName,
    });
  }

  /** {@inheritDoc Transport.setOwnership} */
  setOwnership(_configName: string, _isOwner: boolean): void {
    // Nothing to do: the broker learns of ownership from the `owner-claimed` and
    // `owner-released` messages the client already sends, and routes `to: 'owner'` itself.
  }

  /** {@inheritDoc Transport.close} */
  close(): void {
    if (this.#disposal.isDisposed) {
      return;
    }

    this.send({
      type: 'goodbye',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      to: 'all',
    });

    this.#disposal.disposeAll();
  }

  #receive(raw: unknown): void {
    const result = decodeMessage(raw);
    if (!result.ok) {
      this.#request.onDecodeFailure(result.failure);
      return;
    }

    // The broker has already resolved addressing, so anything arriving here is for us. The
    // one thing still worth checking is that it is not our own message coming back, which
    // would double-deliver every local event.
    if (result.message.from === this.clientId) {
      return;
    }

    this.#request.onMessage(result.message);
  }
}
