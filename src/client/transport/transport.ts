import type { Clock } from '../../core/clock.js';
import type { ScopedLogger } from '../../core/logger.js';
import type { DecodeFailure } from '../../protocol/decode.js';
import type { ClientId, ProtocolMessage } from '../../protocol/messages.js';

/**
 * The message bus, as the rest of the library sees it.
 *
 * Two implementations exist - a `SharedWorker` broker (ADR-0006) and a `BroadcastChannel`
 * fallback (ADR-0007) - and nothing above this interface can tell which is in use. That is
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

  /**
   * Tells the transport whether this context currently owns a configuration.
   *
   * The `BroadcastChannel` fallback needs this to route: with no central router, each context has
   * to decide for itself whether a message addressed to `owner` is meant for it. The
   * `SharedWorker` implementation sends nothing for it, because the broker learns ownership from
   * `owner-claimed`, but repeats it in every heartbeat, so that a broker which forgot this context,
   * or a new worker, can restore it (ADR-0021).
   */
  setOwnership(configName: string, isOwner: boolean): void;

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
   * Called when the transport has reached a new broker after the old one stopped answering
   * (ADR-0021, amended). Whatever was sent or broadcast in between may be lost, so the client asks
   * again for what it needs. Only a `SharedWorker` transport ever reconnects.
   */
  readonly onReconnected?: (() => void) | undefined;
  readonly logger: ScopedLogger;
  /** Time, for the heartbeats a `SharedWorker` participant sends (ADR-0021). */
  readonly clock: Clock;
}
