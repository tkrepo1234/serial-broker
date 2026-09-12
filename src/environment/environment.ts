import type { Transport, TransportRequest } from '../client/transport/transport.js';
import type { Clock, IdGenerator } from '../core/clock.js';
import type { ScopedLogger } from '../core/logger.js';

/**
 * The platform surface this library depends on, in one place.
 *
 * Every browser API the library touches is reached through this object. No module outside
 * `src/environment/` references `navigator`, `window`, `self`, `Date`, `Math.random` or
 * `setTimeout`, and a lint rule enforces it.
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
 */
export interface SerialLike {
  /** Ports the user has already granted this origin. No prompt, no user gesture. */
  getPorts(): Promise<SerialPort[]>;
  /** Shows the port picker. Requires transient user activation. */
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: { readonly target: EventTarget | null }) => void,
  ): void;
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (event: { readonly target: EventTarget | null }) => void,
  ): void;
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
}

/** Options accepted by {@link LockManagerLike.request}. */
export interface LockRequestOptions {
  readonly mode?: 'exclusive' | 'shared';
  /** Aborts a request that is still queued. Never revokes a lock already granted. */
  readonly signal?: AbortSignal;
  /** Returns `null` to the callback instead of queueing, when the lock is already held. */
  readonly ifAvailable?: boolean;
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
