import type { NormalizedConfiguration } from './defaults.js';
import type { SerialBrokerError } from './errors.js';
import type {
  ConnectionSettings,
  EncodingSettings,
  SerialSettings,
  SerialBrokerEventName,
  SerialBrokerStatus,
} from './types.js';

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

/** One of {@link CONNECTION_STATES}. Finer-grained than the public status, on purpose. */
export type ConnectionStateName = (typeof CONNECTION_STATES)[number];

/** The settings a configuration is actually running with, every default applied. */
export interface EffectiveSettings {
  /** USB IDs, or `{ any: true }` for a configuration that accepts any granted port. */
  readonly device:
    { readonly vendorId: number; readonly productId: number } | { readonly any: true };
  readonly serial: Required<SerialSettings>;
  readonly connection: Required<ConnectionSettings>;
  readonly encoding: Required<EncodingSettings>;
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
  readonly name: string;
  /** Whether this context holds the ownership lock right now. */
  readonly role: 'owner' | 'participant';
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
  readonly settings: EffectiveSettings;
  /** Listeners the application has registered in this context, per event. */
  readonly listeners: Readonly<Record<SerialBrokerEventName, number>>;
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
  readonly protocolVersion: number;
  /** Epoch milliseconds at which the context produced this report. */
  readonly reportedAt: number;
  readonly configurations: readonly ConfigurationDiagnostics[];
}

/** A Web Lock this library holds or is waiting for. */
export interface LockDiagnostics {
  readonly name: string;
  readonly mode: 'exclusive' | 'shared';
  /**
   * The browser's identifier for the context, from `LockManager.query()`.
   *
   * Not the same identifier as {@link ParticipantDiagnostics.clientId}: the browser and this
   * library name contexts independently, and nothing maps one onto the other.
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
    | { readonly held: readonly LockDiagnostics[]; readonly pending: readonly LockDiagnostics[] }
    | undefined;
}

/** Fields every observed event carries. */
interface ObservedEventBase {
  readonly configName: string | undefined;
  /** The context that put the event on the bus. */
  readonly from: string;
  /** Epoch milliseconds, from the sending context where it provides one. */
  readonly timestamp: number;
}

/** Something that happened to a watched configuration, somewhere on the origin. */
export type ObservedEvent =
  | (ObservedEventBase & {
      readonly kind: 'received';
      readonly data: Uint8Array;
      readonly text: string | undefined;
    })
  | (ObservedEventBase & {
      readonly kind: 'sent';
      readonly data: Uint8Array;
      /** The context whose write this was. */
      readonly originClientId: string;
    })
  | (ObservedEventBase & { readonly kind: 'status'; readonly status: SerialBrokerStatus })
  | (ObservedEventBase & { readonly kind: 'error'; readonly error: SerialBrokerError })
  | (ObservedEventBase & { readonly kind: 'owner-claimed' | 'owner-released' });

/**
 * Describes a normalised configuration as the settings it runs with.
 *
 * @param configuration - A configuration that has passed validation.
 * @returns A plain, structurally cloneable description.
 */
export function describeSettings(configuration: NormalizedConfiguration): EffectiveSettings {
  return {
    device:
      configuration.device.kind === 'usb'
        ? { vendorId: configuration.device.vendorId, productId: configuration.device.productId }
        : { any: true },
    serial: { ...configuration.serial },
    connection: { ...configuration.connection },
    encoding: { ...configuration.encoding },
    persist: configuration.persist,
  };
}
