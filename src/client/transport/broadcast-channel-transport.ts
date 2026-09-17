import { DisposalStack } from '../../core/disposable.js';
import { OnceLog } from '../../core/logger.js';
import { decodeMessage } from '../../protocol/decode.js';
import { warnLimitExceeded } from '../../protocol/limits.js';
import {
  configNameOf,
  type ProtocolMessage,
  type ProtocolMessageType,
} from '../../protocol/messages.js';
import { brokerChannelName } from '../../protocol/version.js';

import type { Transport, TransportRequest } from './transport.js';

/** The messages a broker sends or is sent, which concern no context in turn. */
const BROKER_MESSAGE_TYPES: ReadonlySet<ProtocolMessageType> = new Set([
  'hello',
  'welcome',
  'worker-log',
]);

/** The `BroadcastChannel` surface this transport uses. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'messageerror', listener: (event: unknown) => void): void;
}

/** Constructs a `BroadcastChannel`. Injected so the harness can substitute one (ADR-0012). */
export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike;

/**
 * Delivers messages through a `BroadcastChannel`, with no broker.
 *
 * Used when `SharedWorker` is unavailable or fails to load (ADR-0006). Every message reaches
 * every context of the origin, and each receiver decides for itself whether a message is
 * addressed to it:
 *
 * | `to` | Accepted when |
 * | --- | --- |
 * | `'all'` | this context has attached to the configuration |
 * | a client id | it is this context's id |
 *
 * That is the whole of it: the envelope carries everything the decision depends on.
 */
export class BroadcastChannelTransport implements Transport {
  readonly kind = 'broadcastchannel' as const;
  readonly clientId;

  readonly #channel: BroadcastChannelLike;
  readonly #disposal = new DisposalStack();
  readonly #request: TransportRequest;
  readonly #attached = new Set<string>();
  readonly #once: OnceLog;

  constructor(request: TransportRequest, createChannel: BroadcastChannelFactory) {
    this.clientId = request.clientId;
    this.#request = request;
    this.#once = new OnceLog(request.logger);
    this.#channel = createChannel(brokerChannelName());

    this.#channel.addEventListener('message', (event: { readonly data: unknown }) => {
      this.#receive(event.data);
    });

    this.#channel.addEventListener('messageerror', (event: unknown) => {
      request.onTransportError(event);
    });

    this.#disposal.add(() => {
      this.#channel.close();
    });
    // No `hello`: with no broker, nobody keeps track of who is on the channel.
  }

  /** {@inheritDoc Transport.send} */
  send(message: ProtocolMessage): void {
    if (this.#disposal.isDisposed) {
      return;
    }
    try {
      this.#channel.postMessage(message);
    } catch (error) {
      this.#request.onTransportError(error);
    }
  }

  /** {@inheritDoc Transport.attach} */
  attach(configName: string): void {
    this.#attached.add(configName);
  }

  /** {@inheritDoc Transport.detach} */
  detach(configName: string): void {
    this.#attached.delete(configName);
  }

  /** {@inheritDoc Transport.close} */
  close(): void {
    if (this.#disposal.isDisposed) {
      return;
    }

    this.#attached.clear();
    for (const failure of this.#disposal.disposeAll()) {
      this.#request.logger.warn('a cleanup step failed while closing the bus', {
        event: 'transport.dispose-failed',
        reason: failure,
      });
    }
  }

  #receive(raw: unknown): void {
    const result = decodeMessage(raw);
    if (!result.ok) {
      if (result.failure.reason === 'limit-exceeded') {
        // Logged once, not reported per message: a sender that exceeds a limit repeats itself.
        warnLimitExceeded(this.#once, 'transport.limit-exceeded', result.failure.limit, {
          messageType: result.failure.type,
          field: result.failure.field,
        });
        return;
      }
      this.#request.onDecodeFailure(result.failure);
      return;
    }

    const message = result.message;

    if (BROKER_MESSAGE_TYPES.has(message.type)) {
      // Addressed to a broker, or written by one, and there is none here. Every script of the origin
      // can post them, and nobody above the transport reads them - on the worker the broker never
      // passes them on - so they go no further, and both transports deliver the same messages. A
      // forwarded worker record posted here is nobody's record, and is dropped with them (ADR-0014).
      return;
    }

    // `BroadcastChannel` does not deliver to the sender, but a future transport swap or a
    // polyfill might, and double-delivering every local event would be a miserable bug to
    // find.
    if (message.from === this.clientId) {
      return;
    }

    if (!this.#isAddressedToUs(message)) {
      return;
    }

    this.#request.onMessage(message);
  }

  #isAddressedToUs(message: ProtocolMessage): boolean {
    if (message.to !== 'all') {
      return message.to === this.clientId;
    }
    // A message with no configuration - a diagnostics request - concerns every context.
    const configName = configNameOf(message);
    return configName === undefined || this.#attached.has(configName);
  }
}
