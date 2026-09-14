import type { DisposalStack } from '../../core/disposable.js';
import type { ProtocolMessage } from '../../protocol/messages.js';
import { PROTOCOL_VERSION } from '../../protocol/version.js';

import type { TransportRequest } from './transport.js';

/**
 * The sending half that both transports share.
 *
 * A `SharedWorker` port and a `BroadcastChannel` differ in how a message arrives and who routes
 * it (ADR-0006, ADR-0007), but not in how one is sent: stop once closed, never throw into the
 * caller, and announce presence and interest with the same four messages. Kept here once, so
 * the two cannot drift apart on either. A helper rather than a base class, because the
 * transports share this and nothing else (docs/guidelines/coding-style.md).
 */
export class MessageSender {
  readonly #request: TransportRequest;
  readonly #post: (message: ProtocolMessage) => void;
  readonly #disposal: DisposalStack;

  /**
   * @param request - Supplies the sender identity, and receives whatever posting throws.
   * @param post - Hands a message to the platform: `postMessage` on a port or a channel.
   * @param disposal - The transport's own; nothing is sent once it has been disposed.
   */
  constructor(
    request: TransportRequest,
    post: (message: ProtocolMessage) => void,
    disposal: DisposalStack,
  ) {
    this.#request = request;
    this.#post = post;
    this.#disposal = disposal;
  }

  /**
   * Sends a message, reporting a failure instead of throwing it (see `Transport.send`).
   *
   * `postMessage` throws on a closed port or channel and on a payload that cannot be cloned.
   * Sending stops once the transport is closed, so either is worth reporting.
   */
  send(message: ProtocolMessage): void {
    if (this.#disposal.isDisposed) {
      return;
    }

    try {
      this.#post(message);
    } catch (error) {
      this.#request.onTransportError(error);
    }
  }

  /**
   * Announces this context. Always the first message a transport sends.
   *
   * @param secret - What the worker holds this context's identity to (ADR-0028). Omitted on
   *   `BroadcastChannel`, where every context of the origin would receive it.
   */
  sendHello(secret?: string): void {
    this.send({
      type: 'hello',
      v: PROTOCOL_VERSION,
      from: this.#request.clientId,
      to: 'all',
      secret,
    });
  }

  /** Says this context is leaving. The last message, sent while the transport can still send. */
  sendGoodbye(): void {
    this.send({ type: 'goodbye', v: PROTOCOL_VERSION, from: this.#request.clientId, to: 'all' });
  }

  /** Declares interest in a configuration. */
  sendAttach(configName: string): void {
    this.send({
      type: 'attach',
      v: PROTOCOL_VERSION,
      from: this.#request.clientId,
      to: 'all',
      configName,
    });
  }

  /** Withdraws interest in a configuration. */
  sendDetach(configName: string): void {
    this.send({
      type: 'detach',
      v: PROTOCOL_VERSION,
      from: this.#request.clientId,
      to: 'all',
      configName,
    });
  }
}
