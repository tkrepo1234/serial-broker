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
}

/**
 * Announces that this context has given up ownership.
 *
 * Sent on a graceful release only, and purely as an optimisation so peers do not have to wait
 * for the successor's `owner-claimed`. Ownership itself is never derived from these messages -
 * only from the Web Lock (ADR-0005), which is also what covers the abrupt-death case: the
 * browser releases the lock, the successor is granted it, and it announces itself.
 */
export interface OwnerReleasedMessage extends Envelope {
  readonly type: 'owner-released';
  readonly configName: string;
}

/** Asks the owner to write `payload` to the device. */
export interface WriteRequestMessage extends Envelope {
  readonly type: 'write-request';
  readonly configName: string;
  readonly requestId: RequestId;
  readonly payload: Uint8Array;
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
}

/** Reports the outcome of a write request to its originator. */
export interface WriteResultMessage extends Envelope {
  readonly type: 'write-result';
  readonly configName: string;
  readonly requestId: RequestId;
  readonly ok: boolean;
  /** Present when `ok` is false. */
  readonly error: SerializedSerialBrokerError | undefined;
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
