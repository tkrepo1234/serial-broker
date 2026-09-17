import type { Clock } from '../../core/clock.js';
import type { ScopedLogger } from '../../core/logger.js';
import type { LockManagerLike } from '../../environment/environment.js';
import type { DecodeFailure } from '../../protocol/decode.js';
import type { ClientId, ProtocolMessage } from '../../protocol/messages.js';

/**
 * The message bus, as the rest of the library sees it.
 *
 * Two implementations exist - a `SharedWorker` broker (ADR-0006) and a `BroadcastChannel`
 * fallback (ADR-0006) - and nothing above this interface can tell which is in use. That is
 * deliberate: the transport is a delivery mechanism, and no correctness property of this
 * library rests on which one delivered a message.
 */
export interface Transport {
  /** This context's identity on the bus. Stable for the life of the transport. */
  readonly clientId: ClientId;

  /** Which implementation is in use. For diagnostics and tests only; never behaviour. */
  readonly kind: 'sharedworker' | 'broadcastchannel';

  /**
   * Sends a message.
   *
   * Never throws: the bus failing is reported through the transport's error callback, because
   * a caller in the middle of a state transition has nothing useful to do with an exception
   * from a `postMessage`.
   */
  send(message: ProtocolMessage): void;

  /**
   * Declares interest in a configuration.
   *
   * Messages addressed to `all` for a configuration this context has not attached to are
   * discarded rather than delivered.
   */
  attach(configName: string): void;

  /** Withdraws interest. */
  detach(configName: string): void;

  /** Closes the bus and releases everything it holds. Idempotent. */
  close(): void;
}

/** Everything a transport needs to open the bus. */
export interface TransportRequest {
  /** Identity to announce on the bus. */
  readonly clientId: ClientId;
  /** Receives every message addressed to this context. */
  readonly onMessage: (message: ProtocolMessage) => void;
  /** Receives messages that failed validation. Reported at `warn`, never thrown. */
  readonly onDecodeFailure: (failure: DecodeFailure) => void;
  /**
   * Receives transport-level failures, such as the worker script failing to load.
   *
   * `recovering` is `true` when the transport is already putting the failure right on its own - a
   * worker that stopped answering is being replaced - so the application has nothing to act on.
   */
  readonly onTransportError: (error: unknown, recovering?: boolean) => void;
  /**
   * Called when the transport has reached a new bus: a new worker after the old one ended, or
   * `BroadcastChannel` after the worker script turned out unusable (ADR-0041). Whatever was sent or
   * broadcast before may be lost, so the client states again what the others need to know.
   */
  readonly onReconnected?: (() => void) | undefined;
  readonly logger: ScopedLogger;
  /** Time, for the deadline of the worker's handshake (ADR-0041). */
  readonly clock: Clock;
  /** The context's Web Locks, which tell the worker and the tabs who is still there (ADR-0041). */
  readonly locks: LockManagerLike;
}
