import { DisposalStack } from '../../core/disposable.js';
import { decodeMessage } from '../../protocol/decode.js';
import type { ProtocolMessage } from '../../protocol/messages.js';
import { brokerChannelName, PROTOCOL_VERSION } from '../../protocol/version.js';

import type { Transport, TransportRequest } from './transport.js';

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
  readonly #request: TransportRequest;
  readonly #attached = new Set<string>();
  readonly #owned = new Set<string>();

  constructor(request: TransportRequest, createChannel: BroadcastChannelFactory) {
    this.clientId = request.clientId;
    this.#request = request;
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
      this.#channel.postMessage(message);
    } catch (error) {
      this.#request.onTransportError(error);
    }
  }

  /** {@inheritDoc Transport.attach} */
  attach(configName: string): void {
    this.#attached.add(configName);
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
    this.#attached.delete(configName);
    this.#owned.delete(configName);
    this.send({
      type: 'detach',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      to: 'all',
      configName,
    });
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

    this.send({
      type: 'goodbye',
      v: PROTOCOL_VERSION,
      from: this.clientId,
      to: 'all',
    });

    this.#attached.clear();
    this.#owned.clear();
    this.#disposal.disposeAll();
  }

  #receive(raw: unknown): void {
    const result = decodeMessage(raw);
    if (!result.ok) {
      this.#request.onDecodeFailure(result.failure);
      return;
    }

    const message = result.message;

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
    const configName = 'configName' in message ? message.configName : undefined;

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
