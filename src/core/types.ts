import type { SerialBrokerErrorCode } from './error-codes.js';
import type { SerialBrokerError } from './errors.js';

/**
 * The condition of a configuration's connection.
 *
 * It describes the *connection*, never the coordination: whether this context or a peer is
 * doing the work is deliberately not representable. See ADR-0009.
 *
 * @remarks
 * Treat this union as extensible. A future version may add a value, and applications must
 * handle an unrecognised status gracefully - typically by falling through to a neutral state
 * rather than throwing.
 *
 * Declared as a constant object with a string-union type of the same name, not as a TypeScript
 * `enum`: `status === SerialBrokerStatus.Open` and `status === 'open'` are both valid, and a
 * `switch` over the union is exhaustive either way.
 *
 * @enum
 */
export const SerialBrokerStatus = {
  /** Registered, but not yet trying to connect. */
  Idle: 'idle',
  /**
   * Waiting for a place: `maxTabs` other tabs use the configuration. The tab joins, and moves
   * on from here, as soon as one of them releases it, closes or crashes. Every tab with a limit
   * starts here, and moves on at once when a place is free. See ADR-0017.
   */
  Queued: 'queued',
  /** No granted port matches the device. Call `requestAccess()` from a user gesture. */
  AwaitingPermission: 'awaiting-permission',
  /** A port is being opened, for the first time or after a loss. */
  Connecting: 'connecting',
  /** The port is open. Data can be sent and will be received. */
  Open: 'open',
  /** The connection was lost and is being re-established automatically. */
  Reconnecting: 'reconnecting',
  /**
   * The connection gave up: after `connection.maxAttempts`, after an attempt the browser refused,
   * or - with `connection.autoReconnect: false` - after the first lost connection or failed attempt.
   * It starts again when `setup()` is called again with the same options, in any tab, and, unless
   * `autoReconnect` is `false`, when the device is plugged in again.
   *
   * Also the status of a tab that withdrew because the tab holding the port runs a different
   * `maxTabs` (ADR-0017); that tab stays here until the configuration is released.
   */
  Failed: 'failed',
  /**
   * The configuration was released in this tab. Delivered as its last event; the tab's listeners
   * for it are removed with it.
   */
  Released: 'released',
} as const;

/** Union of every documented status value. */
export type SerialBrokerStatus = (typeof SerialBrokerStatus)[keyof typeof SerialBrokerStatus];

/**
 * Identifies a device by its USB vendor and product IDs.
 *
 * These identify a device *type*, not an individual device: two identical adapters cannot be
 * told apart, because the platform exposes no serial number. See ADR-0022.
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
 * the device has IDs. See ADR-0022.
 */
export interface AnyDeviceFilter {
  /** Must be `true`. Spelled as a field so the intent is explicit at the call site. */
  readonly any: true;
}

/**
 * Accepts only ports that report no USB identity.
 *
 * Narrower than {@link AnyDeviceFilter}: a USB adapter that happens to be granted as well is
 * left alone. A port that reports only one of the two USB IDs counts as having none, since no
 * filter could find it by half an identity. Like `any`, it cannot tell two such ports apart.
 * See ADR-0022.
 */
export interface NonUsbDeviceFilter {
  /** Must be `true`. */
  readonly nonUsb: true;
}

/** What auto mode resolves to: the identity of the port the user chose. */
export type ResolvedDeviceFilter = UsbDeviceFilter | NonUsbDeviceFilter;

/**
 * Takes the device from the port the user chooses - **auto mode**, which is also what an
 * omitted `device` means.
 *
 * `setup()` waits with `awaiting-permission` until `requestAccess()` opens the picker with no
 * filter. The chosen port's `getInfo()` then decides: `{ vendorId, productId }` when it reports
 * both USB IDs, `{ nonUsb: true }` otherwise. The result is remembered with the configuration,
 * reported by `getStatus()`, and adopted by every other tab that set the name up in auto mode.
 * Until the user has chosen, an auto-mode configuration matches no granted port, even when only
 * one is granted. See ADR-0022.
 */
export interface AutoDeviceFilter {
  /** Must be `true`. */
  readonly auto: true;
  /**
   * The device the configuration has resolved to.
   *
   * Written by the library into the remembered configuration, so `restore()` reconnects without a
   * prompt. An application may pass it to seed the resolution; it is used like the explicit
   * filter it names, while the configuration stays in auto mode and follows the tab holding the
   * port.
   */
  readonly resolved?: ResolvedDeviceFilter | undefined;
}

/** How a configuration says which device it wants. */
export type DeviceFilter =
  UsbDeviceFilter | AnyDeviceFilter | NonUsbDeviceFilter | AutoDeviceFilter;

/**
 * What a configuration's device is, as {@link SerialBrokerStatusSnapshot} reports it.
 *
 * `'auto'` is an auto-mode configuration that has not resolved yet: the user has not chosen a
 * port, and no other tab has. A resolved one reports what it resolved to.
 */
export type DeviceKind = 'usb' | 'non-usb' | 'any' | 'auto';

/**
 * Serial line settings, passed through to `SerialPort.open()`.
 *
 * Mirrors the `SerialOptions` dictionary of the Web Serial API, with this library's defaults
 * applied for everything except `baudRate`. The defaults are the common 8N1 frame: eight data
 * bits, no parity, one stop bit.
 *
 * The tab holding the port opens it with its own line settings, and a tab that takes the port over
 * opens it with its own; settings are not compared between tabs. So pass the same ones for a name
 * in every tab. A second `setup()` in the same tab with different ones is refused with
 * `CONFIGURATION_CONFLICT`.
 */
export interface SerialSettings {
  /** Bits per second: an integer from 1 to 20,000,000. Required; there is no sensible default. */
  readonly baudRate: number;
  /**
   * Data bits per character: `7` or `8`. Seven, with `parity` even or odd, is the 7E1 or 7O1
   * frame some older devices use. Must match the device, like `stopBits` and `parity`.
   *
   * @defaultValue 8
   */
  readonly dataBits?: 7 | 8;
  /**
   * Stop bits per character: `1` or `2`. Must match the device.
   *
   * @defaultValue 1
   */
  readonly stopBits?: 1 | 2;
  /**
   * Parity bit per character: `'none'`, `'even'` or `'odd'`. Must match the device. A mismatch in
   * any of the three does not fail the open; it produces garbage, usually visible as replacement
   * characters in decoded text or as `READ_FAILED`, after which the library opens the port again.
   *
   * @defaultValue 'none'
   */
  readonly parity?: 'none' | 'even' | 'odd';
  /**
   * Size of the browser's read and write buffers for the port, in bytes: 1 to 16,777,216 (16 MiB).
   * The write buffer is what `send()` resolves against (ADR-0011).
   *
   * @defaultValue 255
   */
  readonly bufferSize?: number;
  /**
   * `'hardware'` uses the RTS and CTS lines. Enable it only if the device and the cable support
   * it: with a device that never asserts CTS, every write waits and fails with `WRITE_TIMEOUT`.
   * Web Serial offers no software flow control (XON/XOFF).
   *
   * @defaultValue 'none'
   */
  readonly flowControl?: 'none' | 'hardware';
}

/**
 * Connection supervision settings.
 *
 * Grouped into their own structure so that reconnect behaviour can grow without widening the
 * top-level options object. See ADR-0008.
 */
export interface ConnectionSettings {
  /**
   * Delay before the second attempt, in milliseconds: an integer from 0 to 3,600,000 (an hour).
   * The first retry is immediate.
   *
   * @defaultValue 250
   */
  readonly initialDelayMs?: number;
  /** Multiplier applied per attempt: a number from 1 to 100. @defaultValue 2 */
  readonly factor?: number;
  /**
   * Upper bound for the delay, in milliseconds: an integer from 0 to 3,600,000 (an hour).
   *
   * @defaultValue 30000
   */
  readonly maxDelayMs?: number;
  /** Full-jitter floor as a fraction of the computed delay, `0`-`1`. @defaultValue 0.5 */
  readonly jitter?: number;
  /**
   * Attempts before the status becomes `failed`: an integer from 1 to 1,000,000, or `Infinity`.
   * Not `0`: an attempt is always made, and `autoReconnect: false` is how to say "do not
   * reconnect".
   *
   * @defaultValue Infinity
   */
  readonly maxAttempts?: number;
  /**
   * How long a connection must hold before the attempt counter resets, in milliseconds: an integer
   * from 0 to 3,600,000 (an hour).
   *
   * @defaultValue 5000
   */
  readonly stableAfterMs?: number;
  /**
   * Deadline for `port.open()`, `port.close()` and the other calls into Web Serial that have to
   * finish, in milliseconds: an integer from 1 to 600,000 (ten minutes).
   *
   * @defaultValue 10000
   */
  readonly openTimeoutMs?: number;
  /**
   * Deadline for a single `send()`, including time spent waiting for a connection; and, in the tab
   * holding the port, for how long a write may wait behind others before it begins - one that
   * waited longer is never begun - and for each chunk handed to the device. In milliseconds: an
   * integer from 1 to 600,000 (ten minutes).
   *
   * @defaultValue 5000
   */
  readonly writeTimeoutMs?: number;
  /**
   * Largest chunk handed to the device in one `write()`, in bytes: an integer from 1 to 16,777,216
   * (16 MiB).
   *
   * @defaultValue 4096
   */
  readonly maxWriteChunkBytes?: number;
  /**
   * Reconnect by itself after the connection is lost, and try the next attempt when one fails.
   *
   * With `false`, a lost connection or a failed attempt ends in the status `failed`, with the error
   * reported, and nothing is tried again - not even when the device is plugged in again - until
   * the application calls `setup()` for the configuration again. See ADR-0008.
   *
   * @defaultValue true
   */
  readonly autoReconnect?: boolean;
}

/**
 * How what the device sends is collected before `onReceive` delivers it.
 *
 * A read returns whatever the driver has at that moment, so a device that answers byte by byte
 * produces one event per byte. The tab holding the port collects the bytes until the line has
 * been quiet for `idleMs`, and delivers them as one event. Its settings apply to every tab.
 * See ADR-0002.
 */
export interface ReceiveSettings {
  /**
   * How long the line has to be quiet before what was collected is delivered, in milliseconds: an
   * integer from 0 to 3,600,000 (an hour). `0` delivers every chunk as it is read, the way the Web
   * Serial API returns it.
   *
   * @defaultValue 50
   */
  readonly idleMs?: number;
  /**
   * The longest a delivery waits after its first byte, in milliseconds, however busy the line
   * stays: an integer from 1 to 3,600,000 (an hour). A device that never pauses is still delivered
   * at this pace.
   *
   * @defaultValue 500
   */
  readonly maxWaitMs?: number;
}

/**
 * Text handling.
 *
 * See ADR-0013: received data is always delivered as bytes; text is an addition, decoded with
 * a streaming decoder so that multi-byte characters split across chunks survive.
 *
 * @remarks
 * Text is decoded once, by the tab holding the port, and delivered to every tab as that tab decoded
 * it. So `encoding` and `decodeText` are decided by the tab holding the port: a tab that turned
 * `decodeText` on receives `text: undefined` while a tab with it off holds the port, and the other
 * way round. Tabs that differ here are not in conflict (`CONFIGURATION_CONFLICT` concerns the
 * device and the line settings), so give every tab of a configuration the same values.
 */
export interface EncodingSettings {
  /**
   * The encoding received text is decoded with, when `decodeText` is on: any label `TextDecoder`
   * accepts. Labels are normalised to their canonical name, so `'UTF8'` becomes `'utf-8'`.
   *
   * It does not apply to sending. `TextEncoder` only produces UTF-8, so strings passed to
   * `send()` are always encoded as UTF-8, and with any other encoding configured `send()`
   * rejects a string with `INVALID_ARGUMENT` rather than send bytes the device does not expect.
   * Pass the encoded bytes instead.
   *
   * @defaultValue 'utf-8'
   */
  readonly encoding?: string;
  /** Also deliver `text` on `onReceive`, decoded across chunk boundaries. @defaultValue false */
  readonly decodeText?: boolean;
}

/** Options for {@link SerialBrokerApi.setup}. */
export interface SerialBrokerOptions {
  /**
   * Which device to connect to. Omitted, it is taken from the port the user chooses (auto mode,
   * {@link AutoDeviceFilter}).
   *
   * @defaultValue `{ auto: true }`
   */
  readonly device?: DeviceFilter | undefined;
  /** Line settings for `SerialPort.open()`. Required, because `baudRate` has no default. */
  readonly serial: SerialSettings;
  /** Reconnect and timeout behaviour. @defaultValue `{}`: each field's own default */
  readonly connection?: ConnectionSettings;
  /**
   * How received bytes are collected into `onReceive` events.
   *
   * @defaultValue `{}`: each field's own default
   */
  readonly receive?: ReceiveSettings;
  /** Text encoding and decoding. @defaultValue `{}`: each field's own default */
  readonly encoding?: EncodingSettings;
  /**
   * Remember this configuration in `localStorage`, so that `restore()` sets it up again after a
   * reload, and `setup()` in auto mode takes the device the user chose from it.
   * @defaultValue true
   */
  readonly remember?: boolean;
  /**
   * How many tabs of this origin may use the configuration at the same time, the tab holding the
   * port included: an integer from 1 to 100, or `Infinity`.
   *
   * A tab beyond the limit waits with the status `queued` - it receives nothing and its writes
   * wait - and joins as soon as another tab releases the configuration, closes or crashes, in the
   * order the tabs arrived. `1` gives one tab exclusive use of the device.
   *
   * Every tab has to pass the same limit. A tab that finds the tab holding the port running a
   * different one reports `CONFIGURATION_CONFLICT`, withdraws, and shows the status `failed`.
   * See ADR-0017.
   *
   * @defaultValue Infinity
   */
  readonly maxTabs?: number;
}

/** Options for {@link SerialBrokerApi.release}. */
export interface ReleaseOptions {
  /**
   * Also forget the configuration remembered under this name, so that `restore()` does not bring
   * it back and a later `setup()` starts from nothing.
   *
   * Left at `false`, releasing stops using the configuration in this tab and closes the port if
   * this tab held it, and what is remembered stays: a disconnect is not a deletion, and the
   * application decides when something is forgotten (ADR-0020).
   *
   * The entry is one per name for the whole origin, so it is removed only once no tab still runs
   * the configuration with `remember: true`; a tab that still does keeps it. For a configuration
   * set up with `remember: false` there is nothing stored under the name, and this does nothing.
   * Independent of `forgetDevice` below: pass both to remove every trace of the
   * configuration in this browser.
   *
   * **This tab does not have to be using the configuration.** What is remembered belongs to the
   * origin, so a page that lists the entries - a support page, or the debugging surface - can drop
   * one without setting it up first. There is then nothing to disconnect from, which is not an
   * error; only the forgetting happens.
   *
   * @defaultValue false
   */
  readonly forget?: boolean;
  /**
   * Also revoke the browser's permission via `SerialPort.forget()`, so that the next `setup()`
   * prompts the user again.
   *
   * Forgets every granted port that matches the configuration's device - in auto mode, the device
   * it resolved to - whichever tab calls it. The permission belongs to the port and the origin, so
   * another configuration using the same port loses it too.
   *
   * @defaultValue false
   */
  readonly forgetDevice?: boolean;
}

/** Options for {@link SerialBrokerApi.requestAccess}. */
export interface RequestAccessOptions {
  /**
   * Lets the user choose a different device for a configuration in auto mode that already has one.
   *
   * The picker is opened unfiltered, and the port the user chooses becomes the device of every tab
   * and is remembered, as the first choice was. The tab holding the port closes the old device and
   * opens the new one. A dismissed picker changes nothing. A configuration that names its device
   * rejects with `INVALID_ARGUMENT`: set it up with the other device instead. See ADR-0022.
   *
   * @defaultValue false
   */
  readonly chooseAgain?: boolean;
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
  /** What the device is: configured, or resolved from the port the user chose (ADR-0022). */
  readonly deviceKind: DeviceKind;
  /** The USB vendor ID in effect, or `undefined` unless `deviceKind` is `'usb'`. */
  readonly vendorId: number | undefined;
  /** The USB product ID in effect, or `undefined` unless `deviceKind` is `'usb'`. */
  readonly productId: number | undefined;
  /** The effective serial settings, with defaults applied. */
  readonly serialOptions: Required<SerialSettings>;
  /**
   * How many tabs may use the configuration at once, or `Number.POSITIVE_INFINITY` for no limit
   * (ADR-0017).
   *
   * A status component handed only a name can tell from this whether `queued` is reachable at all,
   * and say what a tab is waiting for, without being passed the options the configuration was set
   * up with.
   */
  readonly maxTabs: number;
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
   * The bytes exactly as the device produced them, as the tab holding the port collected them
   * until the line was quiet (`receive`, ADR-0002).
   *
   * This is a copy; the library retains no reference to it, so it is safe to keep or mutate.
   * Where one delivery ends and the next begins carries no meaning - this library performs no
   * framing (ADR-0002).
   */
  readonly data: Uint8Array;
  /**
   * Present only when `encoding.decodeText` is enabled in the tab holding the port, which decodes
   * for every tab ({@link EncodingSettings}). A character split across reads is whole.
   */
  readonly text: string | undefined;
  /** Epoch milliseconds at which the tab holding the port delivered the bytes. */
  readonly timestamp: number;
  /**
   * `true` when bytes may be missing before this delivery, in this tab: it is the tab's first
   * delivery, the connection was lost or handed to another tab since the previous one (the status
   * left `open`), or the tab's message bus was replaced after its worker died. A message the
   * application was assembling from earlier deliveries - a line, a frame - is then incomplete and
   * should be discarded.
   *
   * `false` when none of these happened since the previous delivery.
   */
  readonly afterGap: boolean;
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
  /** The bytes the browser took for the port. A copy. */
  readonly data: Uint8Array;
  /**
   * `'local'` when this context issued the write, `'remote'` when another one did.
   *
   * This describes the caller's own action, not the coordination topology: no peer identity
   * is exposed. See ADR-0009.
   */
  readonly origin: 'local' | 'remote';
  /** Epoch milliseconds at which the browser took the bytes for the port. */
  readonly timestamp: number;
}

/** Payload of an `onError` event. */
export interface ErrorEvent {
  /**
   * The configuration the listener was registered for. A failure of the tab's environment - its
   * message bus, its storage - is delivered to every configuration of the tab, each under its own
   * name.
   */
  readonly name: string;
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
  /**
   * The status that was in effect before. Equal to `status` in the one event a new listener receives
   * to learn the current status, and in no other.
   */
  readonly previousStatus: SerialBrokerStatus;
  /**
   * Epoch milliseconds at which this tab observed the transition. In the one event a new listener
   * receives to learn the current status, the moment it was delivered.
   */
  readonly timestamp: number;
}

/** Maps each event name to its payload type. */
export interface SerialBrokerEventMap {
  /** The device sent data, collected until the line was quiet. Delivered in every tab. */
  readonly onReceive: ReceiveEvent;
  /** The browser took bytes for the port. Delivered in every tab, including the one that sent them. */
  readonly onSend: SendEvent;
  /**
   * Something went wrong without a call to answer for it. A failure of the connection is
   * delivered in every tab; a listener that threw, and a failure of one tab's message bus or
   * storage, only in that tab. A failed call rejects instead.
   */
  readonly onError: ErrorEvent;
  /**
   * The connection status changed. Delivered in every tab; a new listener first receives one
   * event with the current status.
   */
  readonly onStatusChange: StatusChangeEvent;
}

/**
 * Every subscribable event name: `'onReceive'`, `'onSend'`, `'onError'` or `'onStatusChange'`.
 * {@link SerialBrokerEventMap} gives each one's payload.
 */
export type SerialBrokerEventName = keyof SerialBrokerEventMap;

/** A listener for a given event. */
export type SerialBrokerListener<TEvent extends SerialBrokerEventName> = (
  event: SerialBrokerEventMap[TEvent],
) => void;

/** Removes the subscription it was returned from. Idempotent. */
export type Unsubscribe = () => void;

/** Data accepted by {@link SerialBrokerApi.send}. */
export type SendableData = string | BufferSource;

/** Which message bus to use. See ADR-0006. */
export type TransportKind = 'auto' | 'sharedworker' | 'broadcastchannel';

/** Library-wide settings, applied by `SerialBroker.configure()`. */
export interface SerialBrokerGlobalOptions {
  /**
   * URL of the broker script.
   *
   * Needed when the default resolution via `import.meta.url` does not match how the
   * application serves its assets, and always with the CommonJS build, which has no
   * `import.meta.url`. A `SharedWorker` is identified by its script URL, so this
   * URL must be identical in every tab - a `Blob` URL will not work. See ADR-0006.
   *
   * @defaultValue `serial-broker.worker.js` next to the module, resolved against `import.meta.url`
   */
  readonly workerUrl?: string | URL;
  /** Forces a transport instead of selecting one automatically. @defaultValue 'auto' */
  readonly transport?: TransportKind;
  /**
   * Receives diagnostics. The library logs nothing unless one is supplied.
   *
   * @defaultValue A logger that drops every record
   */
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
  /** Which configuration the record concerns. */
  readonly configName?: string | undefined;
  /** Which browsing context wrote it. This is what correlates records from several tabs. */
  readonly clientId?: string | undefined;
  /** A dotted identifier for the event, such as `supervisor.open`. Stable enough to grep. */
  readonly event?: string | undefined;
  /** Anything else the record carries. Always structurally cloneable. */
  readonly [key: string]: unknown;
}

/**
 * Sink for the library's diagnostics.
 *
 * The library writes nothing to the console on its own; an application opts in by supplying
 * an implementation. See docs/guidelines/error-handling.md.
 */
export interface Logger {
  /**
   * Receives one diagnostic record.
   *
   * Must not throw: a logger that fails must not fail the operation being logged. The library
   * guards against it anyway, but an implementation that throws is a bug in the application.
   */
  log(level: LogLevel, message: string, fields: LogFields): void;
}
