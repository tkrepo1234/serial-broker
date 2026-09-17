import { REMEDIATION, RETRYABLE_CODES, SerialBrokerErrorCode } from './error-codes.js';

/**
 * A `SerialBrokerError` reduced to a plain object.
 *
 * Errors must cross `postMessage` boundaries: a failure in the owning tab has to be reported
 * in every other tab. Structured cloning does not preserve `Error` subclasses or their custom
 * fields, so errors travel in this shape and are rebuilt on arrival.
 *
 * See ADR-0010.
 */
export interface SerializedSerialBrokerError {
  /** Marks the object as one of ours, so a receiver can recognise it before reading it. */
  readonly $type: 'SerialBrokerError';
  /** Stable, machine-readable classification. The only field worth branching on. */
  readonly code: SerialBrokerErrorCode;
  /** The human-readable message. Never parse it; message text may change in a patch release. */
  readonly message: string;
  /** The configuration this error relates to, or `undefined` for a global failure. */
  readonly configName: string | undefined;
  /** Structured detail: attempt counts, timeout values, byte counts, peer versions. */
  readonly context: SerialBrokerErrorContext;
  /** A specific, actionable sentence describing what the developer should do. */
  readonly remediation: string;
  /** `true` when the library is already retrying and the application need not act. */
  readonly isRetryable: boolean;
  /** Epoch milliseconds at which the error was created, in its originating context. */
  readonly timestamp: number;
  /** The underlying failure, reduced to what survives structured cloning. */
  readonly cause: SerializedCause | undefined;
}

/**
 * The structured detail an error carries, beside its code and message.
 *
 * Every field is optional, and deliberately so: which of them an error carries depends on where
 * it arose, several codes arise in more than one place, and an error from another tab may have
 * been built by a later version of this library carrying fields this one has never heard of. The
 * types say what a field means **if it is there** - `context.started` is a boolean or absent,
 * never a string - which is what makes `if (error.context.started === false)` safe to write and a
 * misspelt `startd` a compile error. What each code carries is listed per code in the Errors
 * chapter of the documentation; treat that as documentation, not as a guarantee, and check for
 * `undefined` before acting on a field.
 *
 * Fields are structurally cloneable by construction: primitives, arrays of strings, and plain
 * objects describing a device filter (ADR-0010).
 */
export interface SerialBrokerErrorContext {
  /** Which argument or option failed validation, such as `options.serial.baudRate`. */
  readonly argumentName?: string;
  /** What the argument had to be, in words. */
  readonly expected?: string;
  /** `typeof` the value that was passed, or `'null'`. */
  readonly actualType?: string;
  /** The value that was passed, when it was a primitive worth repeating. */
  readonly actualValue?: string | number | boolean | undefined;
  /** The configured encoding, when a string payload could not be encoded with it. */
  readonly encoding?: string;

  /** What the configuration's device is: configured, or resolved from the chosen port. */
  readonly deviceKind?: 'usb' | 'non-usb' | 'any' | 'auto';
  /** What the configuration expects, when the chosen port is a different device. */
  readonly expectedDevice?: 'usb' | 'non-usb' | 'any' | 'auto';
  /** The configured USB vendor ID, when the chosen port reports another. */
  readonly expectedVendorId?: number | undefined;
  /** The configured USB product ID, when the chosen port reports another. */
  readonly expectedProductId?: number | undefined;
  /** The USB vendor ID the chosen port reports, absent for a port that reports no USB identity. */
  readonly actualVendorId?: number | undefined;
  /** The USB product ID the chosen port reports, absent for a port that reports no USB identity. */
  readonly actualProductId?: number | undefined;
  /** The device filter a name is already set up with, normalised. */
  readonly existing?: DescribedDevice;
  /** The device filter the conflicting call asked for, normalised. */
  readonly requested?: DescribedDevice;

  /** The status the configuration was in when the call was refused. */
  readonly status?: string;
  /** The configuration's own tab limit, in the tab that withdrew. */
  readonly maxTabs?: number;
  /** The tab limit the tab holding the port runs the configuration with. */
  readonly holdingTabMaxTabs?: number;
  /** The configuration names set up in this tab, when none of them was the one asked for. */
  readonly known?: readonly string[];

  /** The write this error belongs to. */
  readonly requestId?: string;
  /** How many bytes the write carried. */
  readonly byteLength?: number;
  /** How many of them reached the port before it stopped taking them. */
  readonly bytesWritten?: number;
  /** The size of the chunk that failed. */
  readonly chunkBytes?: number;
  /**
   * Whether the write had begun when it was rejected. `false` means the device received nothing
   * and never will; `true` means it may still complete after the rejection (ADR-0011).
   */
  readonly started?: boolean;
  /** How long the write waited before its deadline passed. */
  readonly waitedMs?: number;
  /** How many writes were already waiting in the tab holding the port. */
  readonly waiting?: number;
  /** How many bytes those waiting writes carried. */
  readonly waitingBytes?: number;
  /** The timeout that passed, in milliseconds. */
  readonly timeoutMs?: number;
  /** `true` when a payload's buffer was detached before it could be copied. */
  readonly detached?: boolean;

  /** Which connection attempt this was. */
  readonly attempt?: number;
  /** How many attempts had failed when the configuration gave up. */
  readonly attempts?: number;
  /** Why the last attempt failed, or why a write was not begun. */
  readonly reason?: string;
  /** The `DOMException` name the browser threw, mapped or not. */
  readonly domExceptionName?: string | undefined;
  /** Whether a port that opened had a readable stream. */
  readonly hasReadable?: boolean;
  /** Whether a port that opened had a writable stream. */
  readonly hasWritable?: boolean;

  /**
   * The protocol version the other tab announced. Typed as `unknown`: it is whatever that tab
   * put on the wire, and a tab that announces nonsense is exactly the case this reports.
   */
  readonly theirVersion?: unknown;
  /** Which storage operation failed: `'read'`, `'write'` or `'clear'`. */
  readonly operation?: string;
  /** The event a listener was registered for, when that listener threw. */
  readonly event?: string;
  /** Whether the environment had a `navigator` at all. */
  readonly hasNavigator?: boolean;
  /** `true` when the page's origin is opaque, which has no Web Locks. */
  readonly opaqueOrigin?: boolean;
  /** The code another tab reported, when this version does not know it (`UNKNOWN`). */
  readonly reportedCode?: string;
}

/**
 * The context as it is passed when an error is built, rather than as it is read.
 *
 * The same fields, plus room for ones this version has never heard of: an error rebuilt from
 * another tab carries whatever that tab put in it, and adding a field - like adding a code - is
 * not a protocol change. The reading side stays {@link SerialBrokerErrorContext}, which names
 * only what this version documents.
 */
export type BuiltErrorContext = SerialBrokerErrorContext & Readonly<Record<string, unknown>>;

/**
 * A device filter as it is recorded in an error's context.
 *
 * Structural on purpose: the normalised filter types live beside the configuration types, which
 * already import this module, and an error should not be the thing that ties the two together.
 */
export interface DescribedDevice {
  /** What the configuration names: a USB device, a port without USB identity, any port, or auto. */
  readonly kind: 'usb' | 'non-usb' | 'any' | 'auto';
  /** The configured USB vendor ID, for `kind: 'usb'`. */
  readonly vendorId?: number | undefined;
  /** The configured USB product ID, for `kind: 'usb'`. */
  readonly productId?: number | undefined;
  /**
   * What an auto-mode configuration resolved to, for `kind: 'auto'`: the device taken from the
   * port the user chose, or absent while it has not resolved (ADR-0022).
   */
  readonly resolved?: ResolvedDescribedDevice | undefined;
}

/** The device an auto-mode configuration took from the port the user chose. */
export interface ResolvedDescribedDevice {
  /** What that port turned out to be. */
  readonly kind: string;
  /** Its USB vendor ID, where it reports one. */
  readonly vendorId?: number | undefined;
  /** Its USB product ID, where it reports one. */
  readonly productId?: number | undefined;
}

/** An underlying error reduced to what survives structured cloning. */
export interface SerializedCause {
  /** The original error's `name`. For Web Serial failures this is the `DOMException` name. */
  readonly name: string;
  /** The original error's message. */
  readonly message: string;
  /** Present for `DOMException`s, which is how Web Serial reports every failure. */
  readonly domExceptionName?: string;
}

/** Options accepted by the {@link SerialBrokerError} constructor. */
export interface SerialBrokerErrorOptions {
  /** The configuration this error relates to, when it relates to one. */
  readonly configName?: string | undefined;
  /**
   * Structured, structurally-cloneable detail. No DOM nodes, no functions, no ports.
   *
   * Wider than {@link SerialBrokerErrorContext} on purpose: this is the building side, and an
   * error rebuilt from another tab carries whatever that tab put in it - including a field a
   * later version of this library added. The reading side stays the precise interface.
   */
  readonly context?: SerialBrokerErrorContext | BuiltErrorContext | undefined;
  /** Overrides the default remediation from the code table. Rarely needed. */
  readonly remediation?: string | undefined;
  /** Overrides the retryability derived from the code. */
  readonly isRetryable?: boolean | undefined;
  /** Epoch milliseconds. Injected so tests are deterministic (ADR-0012). */
  readonly timestamp?: number | undefined;
  /** The underlying error. Always pass it; never discard a cause. */
  readonly cause?: unknown;
}

/**
 * The single error type this library produces.
 *
 * Every failure - whether it originates in the application, in Web Serial, in the
 * coordination layer or in storage - is reported as a `SerialBrokerError` carrying a stable
 * {@link SerialBrokerErrorCode}, structured context, and a specific remediation sentence.
 *
 * @example
 * ```ts
 * try {
 *   await SerialBroker.send('CardReader', 'PING');
 * } catch (error) {
 *   if (!(error instanceof SerialBrokerError)) throw error;
 *
 *   if (error.code === 'WRITE_TIMEOUT' && error.context.started === false) {
 *     // The write never began, so the device received nothing: it can be sent again later.
 *     retryWhenOpen('CardReader', 'PING');
 *   } else {
 *     showMessage(error.remediation);
 *   }
 * }
 * ```
 */
export class SerialBrokerError extends Error {
  /** Stable, machine-readable classification. Branch on this, never on {@link message}. */
  readonly code: SerialBrokerErrorCode;

  /** The configuration this error relates to, or `undefined` for global failures. */
  readonly configName: string | undefined;

  /** Structured detail: attempt counts, timeout values, byte counts, peer versions. */
  readonly context: SerialBrokerErrorContext;

  /** A specific, actionable sentence describing what the developer should do. */
  readonly remediation: string;

  /** `true` when the library is already retrying and the application need not act. */
  readonly isRetryable: boolean;

  /**
   * Epoch milliseconds at which the error was created. `0` for an error built without a
   * `timestamp`; every error the library reports carries one.
   */
  readonly timestamp: number;

  constructor(
    code: SerialBrokerErrorCode,
    message: string,
    options: SerialBrokerErrorOptions = {},
  ) {
    // The constructor is public, so JavaScript can pass `null` where the types allow only an
    // object. An error that cannot be built would replace the failure it was meant to report.
    const given: unknown = options;
    const settings = (given ?? {}) as SerialBrokerErrorOptions;
    super(message, settings.cause === undefined ? undefined : { cause: settings.cause });

    this.name = 'SerialBrokerError';
    this.code = code;
    this.configName = settings.configName;
    this.context = Object.freeze({ ...settings.context });
    // Looked up as an own entry: a code such as `toString` would otherwise find a function on the
    // prototype, and a code no table knows would leave the mandatory remediation `undefined`.
    this.remediation =
      settings.remediation ??
      (Object.hasOwn(REMEDIATION, code) ? REMEDIATION[code] : REMEDIATION.UNKNOWN);
    this.isRetryable = settings.isRetryable ?? RETRYABLE_CODES.has(code);
    this.timestamp = settings.timestamp ?? 0;

    // Keeps the constructor out of the stack in V8, so the first frame is the throw site.
    // `captureStackTrace` is a V8 extension rather than part of the language, so it is reached
    // through a widened type instead of assumed to exist.
    const { captureStackTrace } = Error as unknown as {
      captureStackTrace?: (target: object, constructorOpt?: unknown) => void;
    };
    if (typeof captureStackTrace === 'function') {
      captureStackTrace(this, SerialBrokerError);
    }
  }

  /**
   * Reduces this error to a structurally-cloneable object.
   *
   * Used both when sending an error to another browsing context and when an application hands
   * it to a logging pipeline that only accepts JSON.
   */
  toJSON(): SerializedSerialBrokerError {
    return {
      $type: 'SerialBrokerError',
      code: this.code,
      message: this.message,
      configName: this.configName,
      context: this.context,
      remediation: this.remediation,
      isRetryable: this.isRetryable,
      timestamp: this.timestamp,
      cause: serializeCause(this.cause),
    };
  }
}

/** Narrows an unknown value to a {@link SerialBrokerError}. */
export function isSerialBrokerError(value: unknown): value is SerialBrokerError {
  return value instanceof SerialBrokerError;
}

/** An error known to carry one particular code, with the context documented for it. */
export interface ErrorWithCode<Code extends SerialBrokerErrorCode> extends SerialBrokerError {
  /** The code {@link hasCode} was asked about. */
  readonly code: Code;
  /** The structured detail, as far as it is documented for that code. */
  readonly context: ContextFor<Code>;
}

/**
 * The context fields documented for one code.
 *
 * `ContextFor<'WRITE_TIMEOUT'>` is the same interface as every other code's: which fields an
 * error carries depends on where it arose rather than on its code alone, and pretending otherwise
 * in the types would promise something the library cannot keep. It exists so that code and
 * documentation can name the connection - `function explain(context: ContextFor<'WRITE_TIMEOUT'>)`
 * says what it takes - and so that narrowing them per code is not a breaking change.
 */
export type ContextFor<Code extends SerialBrokerErrorCode> = Code extends unknown
  ? SerialBrokerErrorContext
  : never;

/**
 * `true` when this error has that code, narrowing its context along with it.
 *
 * ```ts
 * if (hasCode(error, SerialBrokerErrorCode.WRITE_TIMEOUT) && error.context.started === false) {
 *   // The device received nothing and never will: this one is safe to send again.
 * }
 * ```
 *
 * Reads no better than `error.code === …`, and that is fine: it is the place narrowing lives
 * for a code whose fields are certain enough to promise.
 */
export function hasCode<Code extends SerialBrokerErrorCode>(
  error: SerialBrokerError,
  code: Code,
): error is ErrorWithCode<Code> {
  return error.code === code;
}

/**
 * Thrown when an internal invariant is violated.
 *
 * This is always a bug in this library, never a caller mistake, and is reported through both
 * channels (thrown and emitted) so it cannot be missed. See
 * docs/guidelines/defensive-programming.md.
 */
export function internalInvariantError(
  message: string,
  context?: Readonly<Record<string, unknown>>,
): SerialBrokerError {
  return new SerialBrokerError(
    SerialBrokerErrorCode.INTERNAL_INVARIANT,
    `Internal invariant violated: ${message}`,
    { context: context ?? {} },
  );
}

/** Reduces an arbitrary thrown value to the fields that survive structured cloning. */
function serializeCause(cause: unknown): SerializedCause | undefined {
  if (cause == null) {
    return undefined;
  }

  try {
    if (cause instanceof Error) {
      // Widened: the types say string, but a hostile error may carry a Symbol as its name.
      const fields = cause as { name: unknown; message: unknown };
      const name = String(fields.name);
      const serialized: SerializedCause = { name, message: String(fields.message) };
      // `DOMException` is how Web Serial reports every failure, and its `name` is the part
      // worth keeping - it is what the error mapping table keys on.
      return isDomException(cause) ? { ...serialized, domExceptionName: name } : serialized;
    }
  } catch {
    // A cause with a throwing `name` getter, or a revoked proxy that cannot even be asked whether
    // it is an Error. `toJSON()` is how an error reaches other tabs, so it must not throw either.
  }

  return { name: 'NonError', message: describeUnknown(cause) };
}

/**
 * Rebuilds a {@link SerialBrokerError} from its serialized form.
 *
 * The `cause` comes back as a plain `Error` carrying the original name and message: the
 * original class cannot be reconstructed, and pretending otherwise would be misleading.
 */
export function deserializeError(serialized: SerializedSerialBrokerError): SerialBrokerError {
  const cause =
    serialized.cause === undefined
      ? undefined
      : Object.assign(new Error(serialized.cause.message), { name: serialized.cause.name });

  // Adding a code does not change the protocol, so a tab on a later version can report one this
  // version does not know. It is classified as UNKNOWN rather than passed on as a code no
  // application branch can expect, and the code it had is kept.
  const isKnown = (Object.values(SerialBrokerErrorCode) as string[]).includes(serialized.code);

  return new SerialBrokerError(
    isKnown ? serialized.code : SerialBrokerErrorCode.UNKNOWN,
    serialized.message,
    {
      configName: serialized.configName,
      context: isKnown
        ? serialized.context
        : { ...serialized.context, reportedCode: serialized.code },
      remediation: serialized.remediation,
      isRetryable: serialized.isRetryable,
      timestamp: serialized.timestamp,
      cause,
    },
  );
}

/** Narrows an unknown value to a serialized error, for use at message boundaries. */
export function isSerializedError(value: unknown): value is SerializedSerialBrokerError {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // Every field `deserializeError` reads is checked: a message from another tab is untrusted,
  // and a missing cause or message must be dropped here rather than throw there.
  const record = value as Record<string, unknown>;
  const { cause, context } = record;
  return (
    record['$type'] === 'SerialBrokerError' &&
    typeof record['code'] === 'string' &&
    typeof record['message'] === 'string' &&
    typeof record['remediation'] === 'string' &&
    typeof record['isRetryable'] === 'boolean' &&
    typeof record['timestamp'] === 'number' &&
    (record['configName'] === undefined || typeof record['configName'] === 'string') &&
    (context === undefined || (typeof context === 'object' && context !== null)) &&
    (cause === undefined || isSerializedCause(cause))
  );
}

function isSerializedCause(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  );
}

/**
 * Recognises the `AbortError` a cancelled lock request rejects with.
 *
 * Never throws: it runs in the rejection handlers that rejoin a lock queue, and a throw there would
 * leave the context out of it for good.
 */
export function isAbortError(error: unknown): boolean {
  try {
    return (
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'AbortError'
    );
  } catch {
    // A `name` getter that throws. Whatever this is, it is not the platform's abort.
    return false;
  }
}

/**
 * Produces a readable description of a value thrown by code outside this library.
 *
 * Applications throw strings, numbers and plain objects. Interpolating those into a message
 * with `String(value)` yields `[object Object]`, which helps nobody.
 */
export function describeUnknown(value: unknown): string {
  // This function is what reports hostile values, so it must not throw for any of them. Every
  // step can: `instanceof` and even `Object.prototype.toString` throw for a revoked proxy, a
  // getter may throw, and `String` throws for an object whose `toString` does.
  try {
    if (value instanceof Error) {
      try {
        // `String` rather than plain interpolation: a hostile error may carry a Symbol as its name.
        const { name, message } = value as { name: unknown; message: unknown };
        return `${String(name)}: ${String(message)}`;
      } catch {
        return Object.prototype.toString.call(value);
      }
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && value !== null) {
      try {
        // `JSON.stringify` is typed as returning `string`, but returns `undefined` for values
        // it cannot represent. The cast restores the truth the lib declaration hides.
        const json = JSON.stringify(value) as string | undefined;
        return json ?? Object.prototype.toString.call(value);
      } catch {
        // Circular structures and objects with throwing getters are both realistic here.
        return Object.prototype.toString.call(value);
      }
    }
    return String(value);
  } catch {
    return 'a value that cannot be described';
  }
}

/**
 * Detects a `DOMException` without depending on the global existing.
 *
 * The library runs in test environments that have no DOM globals at all (ADR-0012), so a bare
 * `instanceof DOMException` would throw a `ReferenceError` rather than return `false`. The tag
 * is what Web IDL gives every `DOMException`, in any realm. An own `code` is no sign of one: a
 * `DOMException` inherits its `code`, while Node's system errors and many application errors
 * carry one of their own.
 */
function isDomException(error: Error): boolean {
  return Object.prototype.toString.call(error) === '[object DOMException]';
}

/**
 * Gives an error created without a time the moment it reached the caller.
 *
 * Validation runs in core code that has no clock (ADR-0012), so the errors it throws carry the
 * timestamp `0`, where the documentation promises epoch milliseconds. The code that calls it has
 * the clock, and fills the time in once, before the error reaches the application.
 *
 * @returns The same value, for `throw withTimestamp(error, now)`.
 */
export function withTimestamp(error: unknown, now: number): unknown {
  if (error instanceof SerialBrokerError && error.timestamp === 0) {
    Object.defineProperty(error, 'timestamp', {
      value: now,
      enumerable: true,
      configurable: true,
      writable: false,
    });
  }
  return error;
}
