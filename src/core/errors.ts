import { REMEDIATION, RETRYABLE_CODES, SerialBrokerErrorCode } from './error-codes.js';

/**
 * A `SerialBrokerError` reduced to a plain object.
 *
 * Errors must cross `postMessage` boundaries: a failure in the owning tab has to be reported
 * in every other tab. Structured cloning does not preserve `Error` subclasses or their custom
 * fields, so errors travel in this shape and are rebuilt with {@link deserializeError}.
 *
 * See ADR-0012.
 */
export interface SerializedSerialBrokerError {
  readonly $type: 'SerialBrokerError';
  readonly code: SerialBrokerErrorCode;
  readonly message: string;
  readonly configName: string | undefined;
  readonly context: Readonly<Record<string, unknown>>;
  readonly remediation: string;
  readonly isRetryable: boolean;
  readonly timestamp: number;
  readonly cause: SerializedCause | undefined;
}

/** An underlying error reduced to what survives structured cloning. */
export interface SerializedCause {
  readonly name: string;
  readonly message: string;
  /** Present for `DOMException`s, which is how Web Serial reports every failure. */
  readonly domExceptionName?: string;
}

/** Options accepted by the {@link SerialBrokerError} constructor. */
export interface SerialBrokerErrorOptions {
  /** The configuration this error relates to, when it relates to one. */
  readonly configName?: string | undefined;
  /** Structured, structurally-cloneable detail. No DOM nodes, no functions, no ports. */
  readonly context?: Readonly<Record<string, unknown>> | undefined;
  /** Overrides the default remediation from the code table. Rarely needed. */
  readonly remediation?: string | undefined;
  /** Overrides the retryability derived from the code. */
  readonly isRetryable?: boolean | undefined;
  /** Epoch milliseconds. Injected so tests are deterministic (ADR-0014). */
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
 *   if (error instanceof SerialBrokerError && error.code === 'NOT_CONNECTED') {
 *     showOfflineBadge(error.remediation);
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
  readonly context: Readonly<Record<string, unknown>>;

  /** A specific, actionable sentence describing what the developer should do. */
  readonly remediation: string;

  /** `true` when the library is already retrying and the application need not act. */
  readonly isRetryable: boolean;

  /** Epoch milliseconds at which the error was created. */
  readonly timestamp: number;

  constructor(
    code: SerialBrokerErrorCode,
    message: string,
    options: SerialBrokerErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });

    this.name = 'SerialBrokerError';
    this.code = code;
    this.configName = options.configName;
    this.context = Object.freeze({ ...options.context });
    this.remediation = options.remediation ?? REMEDIATION[code];
    this.isRetryable = options.isRetryable ?? RETRYABLE_CODES.has(code);
    this.timestamp = options.timestamp ?? 0;

    // Keeps the constructor out of the stack in V8, so the first frame is the throw site.
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, SerialBrokerError);
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
export function serializeCause(cause: unknown): SerializedCause | undefined {
  if (cause == null) {
    return undefined;
  }

  if (cause instanceof Error) {
    const serialized: SerializedCause = { name: cause.name, message: cause.message };
    // `DOMException` is how Web Serial reports every failure, and its `name` is the part
    // worth keeping - it is what the error mapping table keys on.
    return isDomException(cause)
      ? { ...serialized, domExceptionName: cause.name }
      : serialized;
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

  return new SerialBrokerError(serialized.code, serialized.message, {
    configName: serialized.configName,
    context: serialized.context,
    remediation: serialized.remediation,
    isRetryable: serialized.isRetryable,
    timestamp: serialized.timestamp,
    cause,
  });
}

/** Narrows an unknown value to a serialized error, for use at message boundaries. */
export function isSerializedError(value: unknown): value is SerializedSerialBrokerError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { $type?: unknown }).$type === 'SerialBrokerError'
  );
}

/**
 * Produces a readable description of a value thrown by code outside this library.
 *
 * Applications throw strings, numbers and plain objects. Interpolating those into a message
 * with `String(value)` yields `[object Object]`, which helps nobody.
 */
export function describeUnknown(value: unknown): string {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value) ?? Object.prototype.toString.call(value);
    } catch {
      // Circular structures and objects with throwing getters are both realistic here;
      // the fallback is intentionally dull but always succeeds.
      return Object.prototype.toString.call(value);
    }
  }
  return String(value);
}

/**
 * Detects a `DOMException` without depending on the global existing.
 *
 * The library runs in test environments that have no DOM globals at all (ADR-0014), so a bare
 * `instanceof DOMException` would throw a `ReferenceError` rather than return `false`.
 */
function isDomException(error: Error): boolean {
  return error.constructor.name === 'DOMException' || Object.hasOwn(error, 'code');
}
