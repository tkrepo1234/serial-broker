import type { MessagePortLike } from '../../src/client/transport/shared-worker-transport.js';
import type { TransportRequest } from '../../src/client/transport/transport.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import type { Logger } from '../../src/core/types.js';
import type { ClientId, ProtocolMessage } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';

import { FakeClock } from './fake-clock.js';

/**
 * A `MessagePort` with the test at the other end.
 *
 * The ports inside the {@link FakeBus} connect real contexts through the real broker. This one
 * connects to nobody: it records what is posted into it and dispatches whatever the test hands
 * it, synchronously and uncloned, as a `message` event - so a unit test can feed the code under
 * test anything a broken or foreign peer could send, including values that are not messages at
 * all. Both ends of the worker boundary speak through this surface: a `SharedWorker` transport
 * holds one, and the worker script is handed one per connecting context.
 */
export class FakeMessagePort implements MessagePortLike {
  /** Everything posted into the port, in order. */
  readonly posted: unknown[] = [];
  /** `true` once `close()` was called. */
  closed = false;

  /**
   * Every listener, per event type, in the order added.
   *
   * Kept as a list, as a real port keeps them: a fake that let a second listener replace the first
   * would hide code that adds the same listener over and over.
   */
  readonly #listeners = new Map<string, ((event: never) => void)[]>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  start(): void {
    // Nothing is queued before start: delivery happens only when a test calls deliver().
  }

  close(): void {
    this.closed = true;
  }

  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'messageerror', listener: (event: unknown) => void): void;
  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  /** How many listeners are registered for an event type. */
  listenerCount(type: 'message' | 'messageerror'): number {
    return this.#listeners.get(type)?.length ?? 0;
  }

  /** Dispatches `raw` as a `message` event, as if the other end had posted it. */
  deliver(raw: unknown): void {
    for (const listener of this.#listeners.get('message') ?? []) {
      listener({ data: raw } as never);
    }
  }

  /** Dispatches a `messageerror`, which the browser fires for a message that failed to clone. */
  failToClone(): void {
    for (const listener of this.#listeners.get('messageerror') ?? []) {
      listener({} as never);
    }
  }
}

/**
 * A protocol envelope around `body`, as it crosses `postMessage`.
 *
 * Deliberately untyped: whatever arrives over a port is `unknown` until the decoder accepts it,
 * so a test builds a message the way any sender could - including one the decoder must refuse.
 */
export function envelope(from: string, to: string, body: Record<string, unknown>): unknown {
  return { v: PROTOCOL_VERSION, from, to, ...body };
}

/** A {@link TransportRequest} together with what its callbacks have recorded so far. */
export interface TransportRequestRecorder {
  readonly request: TransportRequest;
  /** The request's clock. Heartbeats run when a test advances it, and not otherwise. */
  readonly clock: FakeClock;
  /** Every message the transport delivered. */
  readonly messages: ProtocolMessage[];
  /** Every message the transport refused to deliver because it failed validation. */
  readonly decodeFailures: unknown[];
  /** Every failure of the transport itself. */
  readonly transportErrors: unknown[];
}

/**
 * What a client hands a transport it creates, with every callback recording.
 *
 * A transport reports through these callbacks and never by throwing - into a `postMessage`
 * handler there is nobody to throw to - so what they recorded is what a test asserts on.
 */
export function recordTransportRequest(
  clientId: ClientId,
  logger: Logger = NOOP_LOGGER,
): TransportRequestRecorder {
  const messages: ProtocolMessage[] = [];
  const decodeFailures: unknown[] = [];
  const transportErrors: unknown[] = [];
  const clock = new FakeClock();

  return {
    clock,
    messages,
    decodeFailures,
    transportErrors,
    request: {
      clientId,
      onMessage: (message) => messages.push(message),
      onDecodeFailure: (failure) => decodeFailures.push(failure),
      onTransportError: (error) => transportErrors.push(error),
      logger: new ScopedLogger(logger, {}),
      clock,
    },
  };
}
