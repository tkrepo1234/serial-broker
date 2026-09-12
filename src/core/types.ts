import type { SerialBrokerErrorCode } from './error-codes.js';
import type { SerialBrokerError } from './errors.js';

/**
 * The condition of a configuration's connection.
 *
 * It describes the *connection*, never the coordination: whether this context or a peer is
 * doing the work is deliberately not representable. See ADR-0011.
 *
 * @remarks
 * Treat this union as extensible. A future version may add a value, and applications must
 * handle an unrecognised status gracefully - typically by falling through to a neutral state
 * rather than throwing.
 */
export const SerialBrokerStatus = {
  /** Registered, but not yet trying to connect. */
  Idle: 'idle',
  /** No granted port matches the device. Call `requestAccess()` from a user gesture. */
  AwaitingPermission: 'awaiting-permission',
  /** A port is being opened, for the first time or after a loss. */
  Connecting: 'connecting',
  /** The port is open. Data can be sent and will be received. */
  Open: 'open',
  /** The connection was lost and is being re-established automatically. */
  Reconnecting: 'reconnecting',
  /** Reconnection gave up. Revived automatically if the device is plugged in again. */
  Failed: 'failed',
  /** The configuration was released. No further events will be delivered. */
  Released: 'released',
} as const;

/** Union of every documented status value. */
export type SerialBrokerStatus = (typeof SerialBrokerStatus)[keyof typeof SerialBrokerStatus];

/**
 * Identifies a device by its USB vendor and product IDs.
 *
 * These identify a device *type*, not an individual device: two identical adapters cannot be
 * told apart, because the platform exposes no serial number. See ADR-0009.
 */
export interface UsbDeviceFilter {
  /** USB vendor ID, `0x0000`-`0xffff`. For a CH340 adapter this is `0x1a86`. */
  readonly vendorId: number;
  /** USB product ID, `0x0000`-`0xffff`. */
  readonly productId: number;
}

/**
 * Accepts any port the user has granted, whatever it is.
 *
 * For ports that are **not** USB devices, and therefore report no vendor or product ID at
 * all: a built-in RS-232 interface on an industrial PC, a virtual COM port pair, a
 * Bluetooth serial profile. `SerialPort.getInfo()` returns nothing identifying for these, so
 * there is no filter to write.
 *
 * The cost is that the library cannot tell two such ports apart. With more than one granted,
 * it uses the first and reports the ambiguity at `warn` level. Use the USB filter whenever
 * the device has IDs. See [ADR-0016](../../docs/adr/0016-non-usb-devices.md).
 */
export interface AnyDeviceFilter {
  /** Must be `true`. Spelled as a field so the intent is explicit at the call site. */
  readonly any: true;
}

/** How a configuration says which device it wants. */
export type DeviceFilter = UsbDeviceFilter | AnyDeviceFilter;

/**
 * Serial line settings, passed through to `SerialPort.open()`.
 *
 * Mirrors the `SerialOptions` dictionary of the Web Serial API, with this library's defaults
 * applied for everything except `baudRate`.
 */
export interface SerialSettings {
  /** Bits per second. Required; there is no sensible default. */
  readonly baudRate: number;
  /** @defaultValue 8 */
  readonly dataBits?: 7 | 8;
  /** @defaultValue 1 */
  readonly stopBits?: 1 | 2;
  /** @defaultValue 'none' */
  readonly parity?: 'none' | 'even' | 'odd';
  /** Read buffer size in bytes. @defaultValue 255 */
  readonly bufferSize?: number;
  /** @defaultValue 'none' */
  readonly flowControl?: 'none' | 'hardware';
}

/**
 * Connection supervision settings.
 *
 * Grouped into their own structure so that reconnect behaviour can grow without widening the
 * top-level options object. See ADR-0010.
 */
export interface ConnectionSettings {
  /** Delay before the second attempt. The first retry is immediate. @defaultValue 250 */
  readonly initialDelayMs?: number;
  /** Multiplier applied per attempt. @defaultValue 2 */
  readonly factor?: number;
  /** Upper bound for the delay. @defaultValue 30000 */
  readonly maxDelayMs?: number;
  /** Full-jitter floor as a fraction of the computed delay, `0`-`1`. @defaultValue 0.5 */
  readonly jitter?: number;
  /** Attempts before the status becomes `failed`. @defaultValue Infinity */
  readonly maxAttempts?: number;
  /** How long a connection must hold before the attempt counter resets. @defaultValue 5000 */
  readonly stableAfterMs?: number;
  /** Deadline for `port.open()` and `port.close()`. @defaultValue 10000 */
  readonly openTimeoutMs?: number;
  /** Deadline for a single `send()`, including time spent waiting for a connection. @defaultValue 5000 */
  readonly writeTimeoutMs?: number;
  /** Largest chunk handed to the device in one `write()`. @defaultValue 4096 */
  readonly maxWriteChunkBytes?: number;
}

/**
 * Text handling.
 *
 * See ADR-0015: received data is always delivered as bytes; text is an addition, decoded with
 * a streaming decoder so that multi-byte characters split across chunks survive.
 */
export interface EncodingSettings {
  /** Encoding used for string payloads passed to `send()`. @defaultValue 'utf-8' */
  readonly encoding?: string;
  /** Also deliver `text` on `onReceive`, decoded across chunk boundaries. @defaultValue false */
  readonly decodeText?: boolean;
}

/** Options for {@link SerialBrokerApi.setup}. */
export interface SerialBrokerOptions {
  /** Which device type to connect to. */
  readonly device: DeviceFilter;
  /** Line settings for `SerialPort.open()`. */
  readonly serial: SerialSettings;
  /** Reconnect and timeout behaviour. */
  readonly connection?: ConnectionSettings;
  /** Text encoding and decoding. */
  readonly encoding?: EncodingSettings;
  /**
   * Persist this configuration so it is restored after a reload.
   * @defaultValue true
   */
  readonly persist?: boolean;
}

/** Options for {@link SerialBrokerApi.release}. */
export interface ReleaseOptions {
  /**
   * Also revoke the browser's permission for the device via `SerialPort.forget()`, so that
   * the next `setup()` prompts the user again.
   *
   * @defaultValue false
   */
  readonly forgetDevice?: boolean;
}

/**
 * A point-in-time view of a configuration.
 *
 * Synchronous and local: it never blocks, and `observedAt` states when it was last updated,
 * so a stale snapshot is recognisable rather than misleading.
 */
export interface SerialBrokerStatusSnapshot {
  /** The configuration name. */
  readonly name: string;
  /** The current connection status. */
  readonly status: SerialBrokerStatus;
  /** The configured USB vendor ID, or `undefined` for a configuration that accepts any port. */
  readonly vendorId: number | undefined;
  /** The configured USB product ID, or `undefined` for a configuration that accepts any port. */
  readonly productId: number | undefined;
  /** The effective serial settings, with defaults applied. */
  readonly serialOptions: Required<SerialSettings>;
  /** Epoch milliseconds at which the current status was entered. */
  readonly since: number;
  /** Epoch milliseconds at which this snapshot was produced. */
  readonly observedAt: number;
  /** Code of the most recent error, or `undefined` if none has occurred. */
  readonly lastErrorCode: SerialBrokerErrorCode | undefined;
}

/** Payload of an `onReceive` event. */
export interface ReceiveEvent {
  /** The configuration name. */
  readonly name: string;
  /**
   * The bytes exactly as the device produced them.
   *
   * This is a copy; the library retains no reference to it, so it is safe to keep or mutate.
   * Chunk boundaries are those of the underlying stream and carry no meaning - this library
   * performs no framing (ADR-0002).
   */
  readonly data: Uint8Array;
  /** Present only when `encoding.decodeText` is enabled. Decoded across chunk boundaries. */
  readonly text: string | undefined;
  /** Epoch milliseconds at which the owning context read the chunk. */
  readonly timestamp: number;
}

/**
 * Payload of an `onSend` event.
 *
 * Fires in every context, including the one that issued the write, so that a tab can display
 * traffic caused by its peers.
 */
export interface SendEvent {
  /** The configuration name. */
  readonly name: string;
  /** The bytes that were handed to the device. A copy. */
  readonly data: Uint8Array;
  /**
   * `'local'` when this context issued the write, `'remote'` when another one did.
   *
   * This describes the caller's own action, not the coordination topology: no peer identity
   * is exposed. See ADR-0011.
   */
  readonly origin: 'local' | 'remote';
  /** Epoch milliseconds at which the bytes were handed to the device. */
  readonly timestamp: number;
}

/** Payload of an `onError` event. */
export interface ErrorEvent {
  /** The configuration name, or `undefined` for a failure not tied to one. */
  readonly name: string | undefined;
  /** The error. Errors raised in a peer context are faithfully reconstructed here. */
  readonly error: SerialBrokerError;
  /** Epoch milliseconds at which the error was observed in this context. */
  readonly timestamp: number;
}

/** Payload of an `onStatusChange` event. */
export interface StatusChangeEvent {
  /** The configuration name. */
  readonly name: string;
  /** The status now in effect. */
  readonly status: SerialBrokerStatus;
  /** The status that was in effect before. */
  readonly previousStatus: SerialBrokerStatus;
  /** Epoch milliseconds at which the transition happened. */
  readonly timestamp: number;
}

/** Maps each event name to its payload type. */
export interface SerialBrokerEventMap {
  readonly onReceive: ReceiveEvent;
  readonly onSend: SendEvent;
  readonly onError: ErrorEvent;
  readonly onStatusChange: StatusChangeEvent;
}

/** Every subscribable event name. */
export type SerialBrokerEventName = keyof SerialBrokerEventMap;

/** A listener for a given event. */
export type SerialBrokerListener<TEvent extends SerialBrokerEventName> = (
  event: SerialBrokerEventMap[TEvent],
) => void;

/** Removes the subscription it was returned from. Idempotent. */
export type Unsubscribe = () => void;

/** Data accepted by {@link SerialBrokerApi.send}. */
export type SendableData = string | BufferSource;

/** Which message bus to use. See ADR-0006 and ADR-0007. */
export type TransportKind = 'auto' | 'sharedworker' | 'broadcastchannel';

/** Library-wide settings, applied by `SerialBroker.configure()`. */
export interface SerialBrokerGlobalOptions {
  /**
   * URL of the broker script.
   *
   * Needed when the default resolution via `import.meta.url` does not match how the
   * application serves its assets. A `SharedWorker` is identified by its script URL, so this
   * URL must be identical in every tab - a `Blob` URL will not work. See ADR-0006.
   */
  readonly workerUrl?: string | URL;
  /** Forces a transport instead of selecting one automatically. @defaultValue 'auto' */
  readonly transport?: TransportKind;
  /** Receives diagnostics. The library logs nothing unless one is supplied. */
  readonly logger?: Logger;
  /**
   * Include payload bytes in `debug` log records.
   *
   * Off by default: serial traffic routinely carries card numbers and PINs.
   * @defaultValue false
   */
  readonly logPayloads?: boolean;
}

/** Severity of a log record. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured fields attached to every log record, so records from several tabs correlate. */
export interface LogFields {
  readonly configName?: string | undefined;
  readonly clientId?: string | undefined;
  readonly event?: string | undefined;
  readonly [key: string]: unknown;
}

/**
 * Sink for the library's diagnostics.
 *
 * The library writes nothing to the console on its own; an application opts in by supplying
 * an implementation. See docs/guidelines/error-handling.md.
 */
export interface Logger {
  log(level: LogLevel, message: string, fields: LogFields): void;
}
