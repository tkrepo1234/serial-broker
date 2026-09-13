import { SerialBrokerErrorCode } from '../core/error-codes.js';
import { describeUnknown, SerialBrokerError } from '../core/errors.js';

/**
 * Turns what Web Serial throws into what this library reports.
 *
 * Every failure from the platform arrives as a `DOMException`, and the only part of it worth
 * keying on is its `name`: the message text differs between Chromium versions and is not a
 * contract. So the mapping is a table of names, kept in one place rather than spread across
 * the call sites that happen to catch things. See ADR-0012.
 *
 * A name that is not in a table falls through to that operation's default code - never to a
 * guess, and never silently: the name is preserved in `context.domExceptionName` so an
 * unmapped case is visible in a bug report and can be added here.
 */

/** What `port.open()` rejections mean. */
const OPEN_FAILURES: Readonly<Record<string, SerialBrokerErrorCode>> = {
  /** The device is no longer attached. Not a failure to report to the user - it is a reconnect. */
  NetworkError: SerialBrokerErrorCode.DEVICE_DISCONNECTED,
  /** The port is already open, which after another context crashed can be a stale state. */
  InvalidStateError: SerialBrokerErrorCode.OPEN_FAILED,
  /** Serial access is blocked by permissions policy, or the context is not secure. */
  SecurityError: SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
  /** The serial settings were rejected - an unsupported baud rate, for instance. */
  NotSupportedError: SerialBrokerErrorCode.OPEN_FAILED,
};

/** What `requestPort()` rejections mean. */
const REQUEST_PORT_FAILURES: Readonly<Record<string, SerialBrokerErrorCode>> = {
  /**
   * Called without transient activation.
   *
   * The most common integration mistake by a wide margin: an `await` before the call spends
   * the user gesture, and the browser then refuses.
   */
  SecurityError: SerialBrokerErrorCode.USER_GESTURE_REQUIRED,
  /** Chromium reports both "the user dismissed the picker" and "no device matched" this way. */
  NotFoundError: SerialBrokerErrorCode.PERMISSION_DENIED,
};

/** Detail attached to a mapped error. */
export interface MappingContext {
  readonly configName: string;
  readonly timestamp: number;
  readonly extra?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Maps a `port.open()` failure.
 *
 * A {@link SerialBrokerError} passes through unchanged: a deadline that already expired has
 * said something more specific than this table could.
 */
export function mapOpenError(error: unknown, context: MappingContext): SerialBrokerError {
  if (error instanceof SerialBrokerError) {
    return error;
  }

  return build(
    error,
    OPEN_FAILURES,
    SerialBrokerErrorCode.OPEN_FAILED,
    context,
    (detail) => `Could not open the port: ${detail}`,
  );
}

/** Maps a `requestPort()` failure. */
export function mapRequestPortError(error: unknown, context: MappingContext): SerialBrokerError {
  if (error instanceof SerialBrokerError) {
    return error;
  }

  return build(
    error,
    REQUEST_PORT_FAILURES,
    SerialBrokerErrorCode.PERMISSION_DENIED,
    context,
    (detail) => `The port picker did not yield a device: ${detail}`,
  );
}

function build(
  error: unknown,
  table: Readonly<Record<string, SerialBrokerErrorCode>>,
  fallback: SerialBrokerErrorCode,
  context: MappingContext,
  message: (detail: string) => string,
): SerialBrokerError {
  const name = domExceptionName(error);
  // Own entries only: the tables are plain objects, and a name such as `constructor` would
  // otherwise find what every object inherits and become the error's code.
  const mapped = name !== undefined && Object.hasOwn(table, name) ? table[name] : undefined;

  return new SerialBrokerError(mapped ?? fallback, message(describeUnknown(error)), {
    configName: context.configName,
    // Always recorded, mapped or not: an unmapped name is exactly what a bug report needs.
    context: { ...context.extra, domExceptionName: name },
    timestamp: context.timestamp,
    cause: error,
  });
}

/**
 * The `name` of a thrown value, which for Web Serial is always a `DOMException` name.
 *
 * Never throws, and yields only a string: the mapping runs inside the supervisor's failure
 * handling, where a throw would leave the attempt with no way out, and the name goes into
 * `context`, which has to survive structured cloning. See docs/guidelines/defensive-programming.md.
 */
function domExceptionName(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  try {
    const { name } = error as { name: unknown };
    return typeof name === 'string' ? name : undefined;
  } catch {
    // A `name` getter that throws: there is no name to key on, and the fallback code applies.
    return undefined;
  }
}
