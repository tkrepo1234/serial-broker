import type { BroadcastChannelFactory } from '../client/transport/broadcast-channel-transport.js';
import type { Transport, TransportRequest } from '../client/transport/transport.js';
import type { Clock, IdGenerator } from '../core/clock.js';
import type { ScopedLogger } from '../core/logger.js';

/**
 * The platform surface this library depends on, in one place.
 *
 * Every browser API the library touches is reached through this object. No module outside
 * `src/environment/` references `navigator`, `window`, `self`, `Date`, `Math.random` or
 * `setTimeout`, and a lint rule enforces it. The one exception is the worker script, which runs in a
 * context of its own that nothing can hand an environment to (`src/worker/serial-broker.worker.ts`).
 *
 * Two things follow, and both are the point:
 *
 * - A test can run a dozen independent simulated tabs in one process, kill any of them at a
 *   chosen instruction boundary, and control every delay exactly.
 * - The complete set of platform requirements is readable here rather than scattered.
 *
 * See ADR-0014.
 */
export interface SerialBrokerEnvironment {
  /** `navigator.serial`, or a faithful stand-in. */
  readonly serial: SerialLike;
  /** `navigator.locks`, or a faithful stand-in. */
  readonly locks: LockManagerLike;
  /** `localStorage`, or a stand-in. May be a no-op store when storage is unavailable. */
  readonly storage: KeyValueStorage;
  /** Opens the message bus. */
  readonly createTransport: (request: TransportRequest) => Transport;
  /**
   * Opens a `BroadcastChannel`, for the version announcement (ADR-0008).
   *
   * Absent where the platform has none. Tabs on other protocol versions then go unnoticed, which
   * costs a diagnosis and nothing else.
   */
  readonly createBroadcastChannel?: BroadcastChannelFactory | undefined;
  /** Time, in every form the library needs it. */
  readonly clock: Clock;
  /** Returns a value in `[0, 1)`. Used only for reconnect jitter. */
  readonly random: () => number;
  /** Produces opaque identifiers for contexts and requests. */
  readonly newId: IdGenerator;
  /** Receives diagnostics. */
  readonly logger: ScopedLogger;
  /**
   * Whether `debug` records may contain payload bytes.
   *
   * Off unless an application asks for it: serial traffic routinely carries card numbers and
   * PINs, and a support engineer reading a console dump must not be reading those. Byte counts
   * are always logged; only the bytes themselves are gated.
   */
  readonly logPayloads: boolean;
}

/**
 * The part of `Serial` this library uses.
 *
 * Narrower than the platform interface on purpose: what is not here cannot be depended on,
 * and a fake only has to be faithful about this much.
 *
 * Structural, like every Web Serial type below it: the platform's own `Serial`, `SerialPort` and
 * the rest are *ambient* types, declared globally by `@types/w3c-web-serial`. A declaration this
 * package publishes that names one of them would not type-check in an application that has not
 * installed those types - which the package cannot make it do. See the amendment to ADR-0014.
 * `navigator.serial` satisfies these interfaces as it stands; nothing is cast on the way in.
 */
export interface SerialLike {
  /** Ports the user has already granted this origin. No prompt, no user gesture. */
  getPorts(): Promise<SerialPortLike[]>;
  /** Shows the port picker. Requires transient user activation. */
  requestPort(options?: SerialPortRequestOptionsLike): Promise<SerialPortLike>;
  addEventListener(type: 'connect' | 'disconnect', listener: DeviceEventListener): void;
  removeEventListener(type: 'connect' | 'disconnect', listener: DeviceEventListener): void;
}

/**
 * Hears that a device was plugged in or unplugged.
 *
 * The event's `target` is the port it concerns. The platform declares it as the `EventTarget`
 * every event has, and that is what this says as well, so that the platform's `Serial` satisfies
 * {@link SerialLike}: the one place that reads it says what it is.
 */
export type DeviceEventListener = (event: { readonly target: EventTarget | null }) => void;

/**
 * The part of `SerialPort` this library uses: open it, read it, write it, close it, and ask what
 * device it is.
 */
export interface SerialPortLike {
  /** Opens the port with the configured line settings. */
  open(options: SerialOptionsLike): Promise<void>;
  /** Closes the port. Refused while a stream of it is still locked. */
  close(): Promise<void>;
  /** Revokes this origin's permission for the device. Absent in older Chromium (ADR-0036). */
  forget(): Promise<void>;
  /** What the browser knows about the device behind the port. Empty for a non-USB port. */
  getInfo(): SerialPortInfoLike;
  /** Bytes from the device, once the port is open. */
  readonly readable: ReadableStream<Uint8Array> | null;
  /** Bytes to the device, once the port is open. */
  readonly writable: WritableStream<Uint8Array> | null;
}

/** The line settings `SerialPortLike.open` takes, mirroring the platform's `SerialOptions`. */
export interface SerialOptionsLike {
  readonly baudRate: number;
  readonly dataBits?: 7 | 8 | undefined;
  readonly stopBits?: 1 | 2 | undefined;
  readonly parity?: 'none' | 'even' | 'odd' | undefined;
  readonly bufferSize?: number | undefined;
  readonly flowControl?: 'none' | 'hardware' | undefined;
}

/** What `SerialPortLike.getInfo` reports. Both members are absent for a port that is not USB. */
export interface SerialPortInfoLike {
  readonly usbVendorId?: number | undefined;
  readonly usbProductId?: number | undefined;
}

/** What {@link SerialLike.requestPort} takes: which devices the picker offers. */
export interface SerialPortRequestOptionsLike {
  readonly filters?: readonly SerialPortFilterLike[] | undefined;
}

/** One entry of {@link SerialPortRequestOptionsLike.filters}. */
export interface SerialPortFilterLike {
  readonly usbVendorId?: number | undefined;
  readonly usbProductId?: number | undefined;
}

/** The part of `LockManager` this library uses. See ADR-0005. */
export interface LockManagerLike {
  /**
   * Requests a lock and holds it for as long as `callback`'s promise is pending.
   *
   * The returned promise settles when the callback's promise settles - or rejects with an
   * `AbortError` if `options.signal` is aborted while still queued.
   */
  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: LockLike | null) => Promise<T>,
  ): Promise<T>;

  /**
   * Lists the locks held and requested across the origin.
   *
   * Optional, and used only by diagnostics (ADR-0018). Nothing about ownership is ever derived
   * from it: a snapshot of a lock manager is stale the moment it is taken.
   */
  query?(): Promise<LockSnapshotLike>;
}

/** Options accepted by {@link LockManagerLike.request}. */
export interface LockRequestOptions {
  readonly mode?: 'exclusive' | 'shared';
  /** Aborts a request that is still queued. Never revokes a lock already granted. */
  readonly signal?: AbortSignal;
  /** Returns `null` to the callback instead of queueing, when the lock is already held. */
  readonly ifAvailable?: boolean;
}

/** What `LockManager.query()` reports. Every field is optional in the specification. */
export interface LockSnapshotLike {
  readonly held?: readonly LockInfoLike[];
  readonly pending?: readonly LockInfoLike[];
}

/** One entry of a {@link LockSnapshotLike}. */
export interface LockInfoLike {
  readonly name?: string;
  readonly mode?: 'exclusive' | 'shared';
  readonly clientId?: string;
}

/** A granted lock. Only its name is of interest. */
export interface LockLike {
  readonly name: string;
  readonly mode: 'exclusive' | 'shared';
}

/**
 * The part of `Storage` this library uses.
 *
 * Every method may throw: `localStorage` throws on access in some privacy configurations and
 * on write when the quota is exhausted. Callers treat all three as fallible.
 */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
