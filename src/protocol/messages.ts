import type { ParticipantDiagnostics } from '../core/diagnostics.js';
import type { SerializedSerialBrokerError } from '../core/errors.js';
import type { SerialBrokerStatus } from '../core/types.js';

/**
 * The message vocabulary spoken between participants and the broker.
 *
 * Every message is a discriminated union member keyed on `type`, carries the protocol version
 * in `v`, and contains only structurally-cloneable values. Nothing here is ever trusted on
 * arrival: `decode.ts` validates every message before a field is read (ADR-0008).
 */

/** Opaque identifier of a participating browsing context. */
export type ClientId = string & { readonly __brand: 'ClientId' };

/** Opaque identifier correlating a write request with its result. */
export type RequestId = string & { readonly __brand: 'RequestId' };

/**
 * Opaque identifier of one term of holding a configuration's port: from the moment a tab is granted
 * the ownership lock until it lets it go (ADR-0026).
 *
 * A tab that holds the port twice has two terms. Messages about ownership, writes and the status
 * carry the term they belong to, because messages from two senders have no order between them: a
 * tab can hear a new holder's claim before the last words of the former one, and only the term
 * tells it whose words those are.
 */
export type TermId = string & { readonly __brand: 'TermId' };

/**
 * Where a message is to be delivered.
 *
 * `'owner'` is resolved at delivery time, not by the sender: ownership can move between a
 * participant deciding to write and the message being routed, and the sender has no way to
 * know. Resolving late means a write always reaches whoever holds the port *now*.
 */
export type MessageTarget = 'all' | 'owner' | ClientId;

/** Fields present on every message. */
interface Envelope {
  /** Protocol version of the sender. See ADR-0008. */
  readonly v: number;
  /** The context that sent it. */
  readonly from: ClientId;
  /** Who should receive it. Senders never receive their own messages back. */
  readonly to: MessageTarget;
}

// --- Participant -> broker ---------------------------------------------------------------

/** Announces a context to the broker. Always the first message a participant sends. */
export interface HelloMessage extends Envelope {
  readonly type: 'hello';
}

/**
 * The broker's answer to `hello`, addressed to the context that said it.
 *
 * Its arrival proves that the worker script loaded and runs. Until then a context keeps what it
 * has sent, so that it can send it again over `BroadcastChannel` should the script fail to load
 * (ADR-0007).
 */
export interface WelcomeMessage extends Envelope {
  readonly type: 'welcome';
}

/** The sender identity the broker uses. It is not a context and never appears in a report. */
export const BROKER_ID = 'serial-broker/broker' as ClientId;

/**
 * Tells the broker, periodically, that a participant is still there and what it takes part in.
 *
 * A `MessagePort` reports nothing when the tab behind it dies, so a participant that stops sending
 * heartbeats is forgotten (ADR-0021). Carrying its configurations lets a heartbeat also restore a
 * participant the broker forgot while it was only silent.
 */
export interface HeartbeatMessage extends Envelope {
  readonly type: 'heartbeat';
  /** Every configuration the sender takes part in. */
  readonly configNames: readonly string[];
  /** The configurations whose port the sender holds. */
  readonly ownedConfigNames: readonly string[];
}

/** Declares interest in a configuration, so its events are routed to this context. */
export interface AttachMessage extends Envelope {
  readonly type: 'attach';
  readonly configName: string;
}

/** Withdraws interest. The broker stops routing that configuration's events here. */
export interface DetachMessage extends Envelope {
  readonly type: 'detach';
  readonly configName: string;
}

/** Announces that this context now holds the ownership lock for a configuration. */
export interface OwnerClaimedMessage extends Envelope {
  readonly type: 'owner-claimed';
  readonly configName: string;
  /** The term that begins. */
  readonly term: TermId;
  /**
   * The tab limit the sender runs the configuration with (ADR-0025).
   *
   * Here as well as in {@link StatusMessage} because the term's Web Lock is named after all three -
   * term, sender and limit - and a tab has to know the name before it can check that the lock is
   * held (ADR-0030).
   */
  readonly maxTabs: number;
}

/**
 * Announces that this context has given up ownership.
 *
 * Sent on a graceful release only, after the port is closed and every write of the term has been
 * answered, and before the lock is let go. It is the term's last message: a sender's messages keep
 * their order, so a tab that hears it has heard everything the term said about its writes
 * (ADR-0026). Ownership itself is never derived from these messages - only from the Web Lock
 * (ADR-0005), which is also what covers the abrupt-death case: the browser releases the lock, the
 * successor is granted it, and it announces itself.
 */
export interface OwnerReleasedMessage extends Envelope {
  readonly type: 'owner-released';
  readonly configName: string;
  /** The term that ended. */
  readonly term: TermId;
}

/** Asks the owner to write `payload` to the device. */
export interface WriteRequestMessage extends Envelope {
  readonly type: 'write-request';
  readonly configName: string;
  readonly requestId: RequestId;
  readonly payload: Uint8Array;
  /**
   * The term the request is addressed to. Only a tab holding the port in that term writes it; any
   * other answers `NOT_CONNECTED`. So a request is only ever written by the term its sender chose,
   * and the sender hands it to another term only once this one has ended (ADR-0026).
   */
  readonly term: TermId;
}

/**
 * Reports that the owner has begun writing a request.
 *
 * This is the point after which the request is no longer replayable: if the owner dies now,
 * whether the bytes reached the device is unknowable. See ADR-0013.
 */
export interface WriteStartedMessage extends Envelope {
  readonly type: 'write-started';
  readonly configName: string;
  readonly requestId: RequestId;
  /** The term writing it. */
  readonly term: TermId;
}

/** Reports the outcome of a write request to its originator. */
export interface WriteResultMessage extends Envelope {
  readonly type: 'write-result';
  readonly configName: string;
  readonly requestId: RequestId;
  readonly ok: boolean;
  /** Present when `ok` is false. */
  readonly error: SerializedSerialBrokerError | undefined;
  /**
   * The term of the tab answering: the one the write was performed in, or, for `NOT_CONNECTED`, the
   * one the tab holds or last held the port in. `undefined` from a tab that never held it.
   */
  readonly term: TermId | undefined;
}

/** Broadcast by the owner when a chunk arrives from the device. */
export interface DataReceivedMessage extends Envelope {
  readonly type: 'data-received';
  readonly configName: string;
  readonly payload: Uint8Array;
  /** Present only when the owner's configuration enables text decoding. */
  readonly text: string | undefined;
  readonly timestamp: number;
}

/** Broadcast by the owner when bytes have been handed to the device. */
export interface DataSentMessage extends Envelope {
  readonly type: 'data-sent';
  readonly configName: string;
  readonly payload: Uint8Array;
  /** The context that requested the write, so it can label the event as its own. */
  readonly originClientId: ClientId;
  readonly timestamp: number;
}

/** Broadcast by the owner when the connection status changes. */
export interface StatusMessage extends Envelope {
  readonly type: 'status';
  readonly configName: string;
  readonly status: SerialBrokerStatus;
  /**
   * The tab limit of the tab sending the status - the one holding the port. A tab running the
   * configuration with a different limit withdraws when it hears this (ADR-0025).
   */
  readonly maxTabs: number;
  /** The term of the tab sending it. A status of a term that has ended or been succeeded is stale. */
  readonly term: TermId;
  readonly timestamp: number;
}

/** Broadcast when an error occurs that every participant should learn about. */
export interface ErrorMessage extends Envelope {
  readonly type: 'error';
  readonly configName: string | undefined;
  readonly error: SerializedSerialBrokerError;
  readonly timestamp: number;
}

/** Asks the current owner to restate the status, so a late joiner is not left guessing. */
export interface StatusRequestMessage extends Envelope {
  readonly type: 'status-request';
  readonly configName: string;
}

/**
 * Asks every context on the bus to describe itself.
 *
 * Carries no configuration name on purpose: the question is who is there and what they are
 * doing, which no single configuration can answer. Sent by a diagnostics observer, which is not
 * a participant and takes no part in ownership (ADR-0018).
 */
export interface DiagnosticsRequestMessage extends Envelope {
  readonly type: 'diagnostics-request';
  readonly requestId: RequestId;
}

/** One context's answer to a {@link DiagnosticsRequestMessage}, addressed to the observer. */
export interface DiagnosticsReportMessage extends Envelope {
  readonly type: 'diagnostics-report';
  readonly requestId: RequestId;
  readonly report: ParticipantDiagnostics;
}

/** Sent by a context that is shutting down gracefully. */
export interface GoodbyeMessage extends Envelope {
  readonly type: 'goodbye';
}

/** Every message that can appear on the bus. */
export type ProtocolMessage =
  | HelloMessage
  | WelcomeMessage
  | HeartbeatMessage
  | AttachMessage
  | DetachMessage
  | OwnerClaimedMessage
  | OwnerReleasedMessage
  | WriteRequestMessage
  | WriteStartedMessage
  | WriteResultMessage
  | DataReceivedMessage
  | DataSentMessage
  | StatusMessage
  | ErrorMessage
  | StatusRequestMessage
  | DiagnosticsRequestMessage
  | DiagnosticsReportMessage
  | GoodbyeMessage;

/** Discriminator values, for exhaustiveness checks. */
export type ProtocolMessageType = ProtocolMessage['type'];

/**
 * The configuration a message concerns, or `undefined` for one that concerns a whole context.
 *
 * Routing - in the broker, in the fallback transport, in the client - depends on this answer, and
 * which message types carry a configuration is a fact of this vocabulary, so it is asked here
 * rather than at every place that routes.
 */
export function configNameOf(message: ProtocolMessage): string | undefined {
  return 'configName' in message ? message.configName : undefined;
}
