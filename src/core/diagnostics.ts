import type { NormalizedConfiguration } from './defaults.js';
import type { SerialBrokerError } from './errors.js';
import type {
  ConnectionSettings,
  EncodingSettings,
  SerialSettings,
  SerialBrokerEventName,
  SerialBrokerStatus,
} from './types.js';
import { toSetupOptions } from './validation.js';

/**
 * The shapes of a diagnostics report (ADR-0018).
 *
 * Everything here describes what ADR-0011 keeps out of the application-facing API: which
 * context owns a port, what the owner's connection is doing, what each context is still waiting
 * on. It reaches an operator through the diagnostics observer, behind its own entry point, and
 * never reaches application code through the main one.
 *
 * @remarks
 * A report describes a moment that is over by the time anyone reads it. Nothing may branch on
 * it; it exists to be looked at.
 */

/** Every state the owner's connection can be in. */
export const CONNECTION_STATES = [
  'idle',
  'awaiting-permission',
  'opening',
  'open',
  'reconnecting',
  'failed',
  'stopped',
] as const;

/**
 * The state of the connection in the tab that holds the port. Finer-grained than the public
 * status, on purpose:
 *
 * | State | Meaning |
 * | --- | --- |
 * | `'idle'` | Not trying to connect. |
 * | `'awaiting-permission'` | No granted port matches the device; waiting for `requestAccess()`. |
 * | `'opening'` | An attempt is in progress: finding the granted port, or opening it. |
 * | `'open'` | The port is open and being read. |
 * | `'reconnecting'` | The last attempt or connection failed, and the next attempt is scheduled. |
 * | `'failed'` | `maxAttempts` attempts failed; revived when the device is plugged in again. |
 * | `'stopped'` | This tab stopped holding the port. |
 */
export type ConnectionStateName = (typeof CONNECTION_STATES)[number];

/** The settings a configuration is actually running with, every default applied. */
export interface EffectiveSettings {
  /**
   * USB IDs, or `{ any: true }` for a configuration that accepts any granted port.
   *
   * Either shape can be passed back to `setup()` unchanged.
   */
  readonly device:
    | {
        /** USB vendor ID, `0x0000`-`0xffff`. */
        readonly vendorId: number;
        /** USB product ID, `0x0000`-`0xffff`. */
        readonly productId: number;
      }
    | {
        /** Always `true`: the configuration accepts whatever port the user granted. */
        readonly any: true;
      };
  /** Line settings the port is opened with, including the defaults that were applied. */
  readonly serial: Required<SerialSettings>;
  /** Reconnect and timeout behaviour, including the defaults that were applied. */
  readonly connection: Required<ConnectionSettings>;
  /** Text encoding and decoding, including the defaults that were applied. */
  readonly encoding: Required<EncodingSettings>;
  /** Whether the configuration is remembered across reloads. */
  readonly persist: boolean;
}

/** The physical connection, as the context holding the port sees it. */
export interface ConnectionDiagnostics {
  /** The supervisor's state machine. `opening` and `stopped` have no public status of their own. */
  readonly state: ConnectionStateName;
  /** Connection attempts made since the counter last reset after a stable connection. */
  readonly attempt: number;
  /** Epoch milliseconds at which the next reconnect attempt is due, while one is scheduled. */
  readonly nextAttemptAt: number | undefined;
  /** Epoch milliseconds at which the current connection opened, while it is open. */
  readonly openedAt: number | undefined;
  /** Writes queued at the port, including the one being written. */
  readonly queuedWrites: number;
  /** Bytes read from the device since this context became the owner. */
  readonly bytesReceived: number;
  /** Bytes handed to the device since this context became the owner. */
  readonly bytesSent: number;
}

/** Writes a context has issued and that have not settled yet. */
export interface PendingWritesDiagnostics {
  /** All of them. */
  readonly total: number;
  /** Handed to an owner that has not answered yet. The rest are waiting for a connection. */
  readonly dispatched: number;
  /** Begun at the device. From here on a write is never repeated (ADR-0013). */
  readonly started: number;
}

/** One configuration, as one context sees it. */
export interface ConfigurationDiagnostics {
  /** The configuration name, as passed to `setup()`. */
  readonly name: string;
  /** Whether this context holds the ownership lock right now. */
  readonly role: 'owner' | 'participant';
  /** The connection status as this context last learned it. */
  readonly status: SerialBrokerStatus;
  /** Epoch milliseconds at which the current status was entered in this context. */
  readonly statusSince: number;
  /**
   * The code of the most recent error this context saw for the configuration.
   *
   * A plain string rather than the error-code union: a report is display-only, and a peer on a
   * newer build may know a code this one does not.
   */
  readonly lastErrorCode: string | undefined;
  /** The settings this context runs the configuration with. */
  readonly settings: EffectiveSettings;
  /** Listeners the application has registered in this context, per event. */
  readonly listeners: Readonly<Record<SerialBrokerEventName, number>>;
  /** Writes this context has issued that have not settled yet. */
  readonly pendingWrites: PendingWritesDiagnostics;
  /** Present only in the context that owns the port. */
  readonly connection: ConnectionDiagnostics | undefined;
}

/** One context's answer to a diagnostics request. */
export interface ParticipantDiagnostics {
  /** The context's identity on the bus. Opaque, and different on every page load. */
  readonly clientId: string;
  /** Which message bus this context ended up on. */
  readonly transport: 'sharedworker' | 'broadcastchannel';
  /** The version of the message protocol between tabs that this context speaks. */
  readonly protocolVersion: number;
  /** Epoch milliseconds at which the context produced this report. */
  readonly reportedAt: number;
  /** Every configuration this context has set up, in registration order. */
  readonly configurations: readonly ConfigurationDiagnostics[];
}

/** A Web Lock this library holds or is waiting for. */
export interface LockDiagnostics {
  /** The lock name, `serial-broker/owner/v<protocol version>/<configuration name>`. */
  readonly name: string;
  /** The lock mode. Ownership locks are always exclusive. */
  readonly mode: 'exclusive' | 'shared';
  /**
   * The browser's identifier for the context, from `LockManager.query()`.
   *
   * Not the same identifier as `ParticipantDiagnostics.clientId`: the browser and this library
   * name contexts independently, and nothing maps one onto the other.
   */
  readonly browserClientId: string | undefined;
}

/** Everything one collection gathered. */
export interface DiagnosticsSnapshot {
  /** Epoch milliseconds at which the collection window closed. */
  readonly collectedAt: number;
  /** The observer's own identity on the bus, which appears in no report. */
  readonly observerClientId: string;
  /** Every context that answered within the window, in the order the answers arrived. */
  readonly participants: readonly ParticipantDiagnostics[];
  /**
   * This library's Web Locks across the origin, or `undefined` where the browser cannot list
   * them. The holder of `serial-broker/owner/…/<name>` is the owner of that configuration.
   */
  readonly locks:
    | {
        /** Locks granted to a context right now. */
        readonly held: readonly LockDiagnostics[];
        /** Requests queued behind a holder, longest-waiting first. */
        readonly pending: readonly LockDiagnostics[];
      }
    | undefined;
}

/** Fields every observed event carries. */
export interface ObservedEventBase {
  /** The configuration the event concerns, or `undefined` for a failure tied to none. */
  readonly configName: string | undefined;
  /** The context that put the event on the bus. */
  readonly from: string;
  /** Epoch milliseconds, from the sending context where it provides one. */
  readonly timestamp: number;
}

/** The device sent data. */
export interface ObservedReceived extends ObservedEventBase {
  /** Always `'received'`. */
  readonly kind: 'received';
  /** The bytes exactly as the device produced them. */
  readonly data: Uint8Array;
  /** The decoded text, when the owner's configuration decodes text. */
  readonly text: string | undefined;
}

/** Bytes were handed to the device. */
export interface ObservedSent extends ObservedEventBase {
  /** Always `'sent'`. */
  readonly kind: 'sent';
  /** The bytes that were written. */
  readonly data: Uint8Array;
  /** The context whose write this was. */
  readonly originClientId: string;
}

/** The connection status changed. */
export interface ObservedStatus extends ObservedEventBase {
  /** Always `'status'`. */
  readonly kind: 'status';
  /** The status now in effect. */
  readonly status: SerialBrokerStatus;
}

/** Something went wrong. */
export interface ObservedError extends ObservedEventBase {
  /** Always `'error'`. */
  readonly kind: 'error';
  /** The error, rebuilt with its code, context and remediation. */
  readonly error: SerialBrokerError;
}

/** A context took the port, or gave it up. That context is `from`. */
export interface ObservedOwnership extends ObservedEventBase {
  /** `'owner-claimed'` or `'owner-released'`. */
  readonly kind: 'owner-claimed' | 'owner-released';
}

/**
 * Something that happened to a watched configuration, somewhere on the origin.
 *
 * Tell the kinds apart by `kind`:
 *
 * | `kind` | Type | What happened |
 * | --- | --- | --- |
 * | `'received'` | {@link ObservedReceived} | The device sent data. |
 * | `'sent'` | {@link ObservedSent} | Bytes were handed to the device. |
 * | `'status'` | {@link ObservedStatus} | The connection status changed. |
 * | `'error'` | {@link ObservedError} | Something went wrong. |
 * | `'owner-claimed'`, `'owner-released'` | {@link ObservedOwnership} | A tab took the port, or gave it up. |
 */
export type ObservedEvent =
  ObservedReceived | ObservedSent | ObservedStatus | ObservedError | ObservedOwnership;

/**
 * Describes a normalised configuration as the settings it runs with.
 *
 * The settings a report shows are exactly the options `setup()` would accept, so this is the
 * same conversion as {@link toSetupOptions} - kept under its own name because it is what the
 * diagnostics view calls, and a report must never describe a configuration differently from how
 * it would be restored.
 *
 * @param configuration - A configuration that has passed validation.
 * @returns A plain, structurally cloneable description.
 */
export function describeSettings(configuration: NormalizedConfiguration): EffectiveSettings {
  return toSetupOptions(configuration);
}
