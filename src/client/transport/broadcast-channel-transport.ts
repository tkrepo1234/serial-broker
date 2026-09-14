import { DisposalStack } from '../../core/disposable.js';
import { decodeMessage } from '../../protocol/decode.js';
import { LimitWarnings } from '../../protocol/limits.js';
import {
  configNameOf,
  type ProtocolMessage,
  type ProtocolMessageType,
} from '../../protocol/messages.js';
import { brokerChannelName } from '../../protocol/version.js';

import { MessageSender } from './message-sender.js';
import type { Transport, TransportRequest } from './transport.js';

/** The messages that tell a broker about a context, and concern no context in turn. */
const PRESENCE_MESSAGE_TYPES: ReadonlySet<ProtocolMessageType> = new Set([
  'hello',
  'welcome',
  'heartbeat',
  'goodbye',
  'attach',
  'detach',
]);

/** The `BroadcastChannel` surface this transport uses. */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  addEventListener(type: 'messageerror', listener: (event: unknown) => void): void;
}

/** Constructs a `BroadcastChannel`. Injected so the harness can substitute one (ADR-0014). */
export type BroadcastChannelFactory = (name: string) => BroadcastChannelLike;

/**
 * Delivers messages through a `BroadcastChannel`, with no broker.
 *
 * Used when `SharedWorker` is unavailable or fails to load (ADR-0007). Every message reaches
 * every context of the origin, and each receiver decides for itself whether a message is
 * addressed to it:
 *
 * | `to` | Accepted when |
 * | --- | --- |
 * | `'all'` | this context has attached to the configuration |
 * | `'owner'` | this context currently holds the ownership lock for it |
 * | a client id | it is this context's id |
 *
 * That is the whole of it. The addressing decision is possible locally because the envelope
 * carries everything it depends on, and because ownership is a Web Lock this context either
 * holds or does not (ADR-0005) - there is nothing to agree with anyone else about.
 */
export class BroadcastChannelTransport implements Transport {
  readonly kind = 'broadcastchannel' as const;
  readonly clientId;

  readonly #channel: BroadcastChannelLike;
  readonly #disposal = new DisposalStack();
  readonly #sender: MessageSender;
  readonly #request: TransportRequest;
  readonly #attached = new Set<string>();
  readonly #owned = new Set<string>();
  readonly #limits: LimitWarnings;

  constructor(request: TransportRequest, createChannel: BroadcastChannelFactory) {
    this.clientId = request.clientId;
    this.#request = request;
    this.#limits = new LimitWarnings(request.logger, 'transport.limit-exceeded');
    this.#channel = createChannel(brokerChannelName());
    this.#sender = new MessageSender(
      request,
      (message) => {
        this.#channel.postMessage(message);
      },
      this.#disposal,
    );

    this.#channel.addEventListener('message', (event: { readonly data: unknown }) => {
      this.#receive(event.data);
    });

    this.#channel.addEventListener('messageerror', (event: unknown) => {
      request.onTransportError(event);
    });

    this.#disposal.add(() => {
      this.#channel.close();
    });

    this.#sender.sendHello();
  }

  /** {@inheritDoc Transport.send} */
  send(message: ProtocolMessage): void {
    this.#sender.send(message);
  }

  /** {@inheritDoc Transport.attach} */
  attach(configName: string): void {
    this.#attached.add(configName);
    this.#sender.sendAttach(configName);
  }

  /** {@inheritDoc Transport.detach} */
  detach(configName: string): void {
    this.#attached.delete(configName);
    this.#owned.delete(configName);
    this.#sender.sendDetach(configName);
  }

  /** {@inheritDoc Transport.setOwnership} */
  setOwnership(configName: string, isOwner: boolean): void {
    if (isOwner) {
      this.#owned.add(configName);
    } else {
      this.#owned.delete(configName);
    }
  }

  /** {@inheritDoc Transport.close} */
  close(): void {
    if (this.#disposal.isDisposed) {
      return;
    }

    this.#sender.sendGoodbye();

    this.#attached.clear();
    this.#owned.clear();
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
        this.#limits.exceeded(result.failure.limit, {
          messageType: result.failure.type,
          field: result.failure.field,
        });
        return;
      }
      this.#request.onDecodeFailure(result.failure);
      return;
    }

    const message = result.message;

    if (PRESENCE_MESSAGE_TYPES.has(message.type)) {
      // Addressed to a broker, and there is none here. Every script of the origin can post them, and
      // nobody above the transport reads them - on the worker the broker never passes them on - so
      // they go no further, and both transports deliver the same messages.
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
    const configName = configNameOf(message);

    switch (message.to) {
      case 'all':
        // Messages with no configuration - `hello`, `goodbye` - concern every context.
        return configName === undefined || this.#attached.has(configName);

      case 'owner':
        return configName !== undefined && this.#owned.has(configName);

      default:
        return message.to === this.clientId;
    }
  }
}
