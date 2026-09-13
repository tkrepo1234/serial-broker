import {
  DEFAULT_CONNECTION_SETTINGS,
  DEFAULT_ENCODING_SETTINGS,
  DEFAULT_SERIAL_SETTINGS,
  MAX_CONFIG_NAME_LENGTH,
  type NormalizedConfiguration,
  type NormalizedDeviceFilter,
} from './defaults.js';
import { SerialBrokerErrorCode } from './error-codes.js';
import { SerialBrokerError } from './errors.js';
import type { SerialBrokerOptions } from './types.js';

/**
 * The application-facing validation boundary.
 *
 * Everything the application passes is validated exactly once, here, and converted into a
 * {@link NormalizedConfiguration} that the rest of the library may trust without re-checking.
 * Nothing is coerced silently: a string where a number belongs is an error, not a parse.
 *
 * See docs/guidelines/defensive-programming.md.
 */

const USB_ID_MAX = 0xffff;
const VALID_DATA_BITS: readonly number[] = [7, 8];
const VALID_STOP_BITS: readonly number[] = [1, 2];
const VALID_PARITY: readonly string[] = ['none', 'even', 'odd'];
const VALID_FLOW_CONTROL: readonly string[] = ['none', 'hardware'];

/** Raises an `INVALID_ARGUMENT` error naming the offending argument and what was expected. */
function invalid(argumentName: string, expected: string, actual: unknown): SerialBrokerError {
  return new SerialBrokerError(
    SerialBrokerErrorCode.INVALID_ARGUMENT,
    `${argumentName} must be ${expected}`,
    {
      context: {
        argumentName,
        expected,
        actualType: actual === null ? 'null' : typeof actual,
        actualValue: isLoggableValue(actual) ? actual : undefined,
      },
    },
  );
}

/** Only primitives go into error context; an arbitrary object may not be cloneable. */
function isLoggableValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * Validates a configuration name.
 *
 * The name is the capability: it addresses a configuration in every API call and appears in
 * the Web Lock name, the storage key and every log record. It therefore has to be a non-empty
 * string with no control characters and a bounded length.
 *
 * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT`.
 */
export function validateName(name: unknown, argumentName = 'name'): string {
  if (typeof name !== 'string') {
    throw invalid(argumentName, 'a string', name);
  }
  if (name.length === 0) {
    throw invalid(argumentName, 'a non-empty string', name);
  }
  if (name.length > MAX_CONFIG_NAME_LENGTH) {
    throw invalid(
      argumentName,
      `at most ${String(MAX_CONFIG_NAME_LENGTH)} characters`,
      name.length,
    );
  }
  // Control characters would corrupt the Web Lock name, the storage key and every log
  // record this name appears in. Checked by code point rather than by regular expression so
  // the intent is readable without decoding escapes.
  for (let index = 0; index < name.length; index += 1) {
    const codePoint = name.charCodeAt(index);
    if (codePoint < 0x20 || codePoint === 0x7f) {
      throw invalid(argumentName, 'free of control characters', name);
    }
  }
  return name;
}

function requireInteger(value: unknown, argumentName: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalid(argumentName, 'an integer', value);
  }
  if (value < min || value > max) {
    throw invalid(argumentName, `an integer between ${String(min)} and ${String(max)}`, value);
  }
  return value;
}

function requireFiniteNumber(
  value: unknown,
  argumentName: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw invalid(argumentName, 'a number', value);
  }
  if (value < min || value > max) {
    throw invalid(argumentName, `between ${String(min)} and ${String(max)}`, value);
  }
  return value;
}

function requireOneOf<T extends string | number>(
  value: unknown,
  argumentName: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T)) {
    throw invalid(argumentName, `one of ${allowed.map(String).join(', ')}`, value);
  }
  return value as T;
}

function requireBoolean(value: unknown, argumentName: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalid(argumentName, 'a boolean', value);
  }
  return value;
}

function requireObject(value: unknown, argumentName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(argumentName, 'an object', value);
  }
  return value as Record<string, unknown>;
}

/**
 * Validates a device filter.
 *
 * Two shapes, kept apart rather than merged into one with optional IDs: a configuration
 * either identifies a USB device or accepts whatever the user granted, and code downstream
 * must not be able to read a vendor ID from the second kind. See
 * ADR-0016.
 *
 * Mixing them - passing `any` *and* IDs - is rejected rather than silently resolved, because
 * either interpretation would be a guess about what the caller meant.
 */
function normalizeDeviceFilter(device: Record<string, unknown>): NormalizedDeviceFilter {
  const wantsAny = device['any'];
  const hasIds = device['vendorId'] !== undefined || device['productId'] !== undefined;

  if (wantsAny !== undefined) {
    if (wantsAny !== true) {
      throw invalid('options.device.any', 'true, or absent', wantsAny);
    }
    if (hasIds) {
      throw invalid(
        'options.device',
        'either { vendorId, productId } or { any: true }, not both',
        'both',
      );
    }
    return Object.freeze({ kind: 'any' as const });
  }

  return Object.freeze({
    kind: 'usb' as const,
    vendorId: requireInteger(device['vendorId'], 'options.device.vendorId', 0, USB_ID_MAX),
    productId: requireInteger(device['productId'], 'options.device.productId', 0, USB_ID_MAX),
  });
}

/**
 * Validates and normalises the options passed to `setup()`.
 *
 * @param name - The configuration name.
 * @param options - Raw, untrusted options from the application.
 * @returns A fully resolved configuration with every default applied.
 * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT`, naming the first invalid
 *   field in `context.argumentName`.
 */
export function normalizeConfiguration(name: unknown, options: unknown): NormalizedConfiguration {
  const validName = validateName(name);
  const raw = requireObject(options, 'options') as unknown as SerialBrokerOptions;

  const device = requireObject(raw.device, 'options.device');
  const serial = requireObject(raw.serial, 'options.serial');
  const connection =
    raw.connection === undefined ? {} : requireObject(raw.connection, 'options.connection');
  const encoding =
    raw.encoding === undefined ? {} : requireObject(raw.encoding, 'options.encoding');

  const maxAttemptsRaw = connection['maxAttempts'] ?? DEFAULT_CONNECTION_SETTINGS.maxAttempts;

  return Object.freeze({
    name: validName,
    device: normalizeDeviceFilter(device),
    serial: Object.freeze({
      // The upper bound is generous rather than authoritative: the set of supported rates is
      // a property of the adapter, not of this library, and rejecting an unusual but valid
      // rate would be worse than letting `open()` report it.
      baudRate: requireInteger(serial['baudRate'], 'options.serial.baudRate', 1, 20_000_000),
      dataBits: requireOneOf(
        serial['dataBits'] ?? DEFAULT_SERIAL_SETTINGS.dataBits,
        'options.serial.dataBits',
        VALID_DATA_BITS,
      ) as 7 | 8,
      stopBits: requireOneOf(
        serial['stopBits'] ?? DEFAULT_SERIAL_SETTINGS.stopBits,
        'options.serial.stopBits',
        VALID_STOP_BITS,
      ) as 1 | 2,
      parity: requireOneOf(
        serial['parity'] ?? DEFAULT_SERIAL_SETTINGS.parity,
        'options.serial.parity',
        VALID_PARITY,
      ) as 'none' | 'even' | 'odd',
      bufferSize: requireInteger(
        serial['bufferSize'] ?? DEFAULT_SERIAL_SETTINGS.bufferSize,
        'options.serial.bufferSize',
        1,
        16 * 1024 * 1024,
      ),
      flowControl: requireOneOf(
        serial['flowControl'] ?? DEFAULT_SERIAL_SETTINGS.flowControl,
        'options.serial.flowControl',
        VALID_FLOW_CONTROL,
      ) as 'none' | 'hardware',
    }),
    connection: Object.freeze({
      initialDelayMs: requireInteger(
        connection['initialDelayMs'] ?? DEFAULT_CONNECTION_SETTINGS.initialDelayMs,
        'options.connection.initialDelayMs',
        0,
        3_600_000,
      ),
      factor: requireFiniteNumber(
        connection['factor'] ?? DEFAULT_CONNECTION_SETTINGS.factor,
        'options.connection.factor',
        1,
        100,
      ),
      maxDelayMs: requireInteger(
        connection['maxDelayMs'] ?? DEFAULT_CONNECTION_SETTINGS.maxDelayMs,
        'options.connection.maxDelayMs',
        0,
        3_600_000,
      ),
      jitter: requireFiniteNumber(
        connection['jitter'] ?? DEFAULT_CONNECTION_SETTINGS.jitter,
        'options.connection.jitter',
        0,
        1,
      ),
      // Infinity is the documented default and must stay accepted, so this one field cannot
      // go through `requireInteger`.
      maxAttempts:
        maxAttemptsRaw === Number.POSITIVE_INFINITY
          ? Number.POSITIVE_INFINITY
          : requireInteger(maxAttemptsRaw, 'options.connection.maxAttempts', 0, 1_000_000),
      stableAfterMs: requireInteger(
        connection['stableAfterMs'] ?? DEFAULT_CONNECTION_SETTINGS.stableAfterMs,
        'options.connection.stableAfterMs',
        0,
        3_600_000,
      ),
      openTimeoutMs: requireInteger(
        connection['openTimeoutMs'] ?? DEFAULT_CONNECTION_SETTINGS.openTimeoutMs,
        'options.connection.openTimeoutMs',
        1,
        600_000,
      ),
      writeTimeoutMs: requireInteger(
        connection['writeTimeoutMs'] ?? DEFAULT_CONNECTION_SETTINGS.writeTimeoutMs,
        'options.connection.writeTimeoutMs',
        1,
        600_000,
      ),
      maxWriteChunkBytes: requireInteger(
        connection['maxWriteChunkBytes'] ?? DEFAULT_CONNECTION_SETTINGS.maxWriteChunkBytes,
        'options.connection.maxWriteChunkBytes',
        1,
        16 * 1024 * 1024,
      ),
    }),
    encoding: Object.freeze({
      encoding: validateEncodingLabel(
        encoding['encoding'] ?? DEFAULT_ENCODING_SETTINGS.encoding,
        'options.encoding.encoding',
      ),
      decodeText: requireBoolean(
        encoding['decodeText'] ?? DEFAULT_ENCODING_SETTINGS.decodeText,
        'options.encoding.decodeText',
      ),
    }),
    persist: requireBoolean(raw.persist ?? true, 'options.persist'),
  });
}

/**
 * Checks that an encoding label is one `TextDecoder` will accept.
 *
 * Verified eagerly rather than at first use: an unknown label would otherwise surface as a
 * `RangeError` from deep inside the owning tab's read loop, minutes after the mistake.
 */
function validateEncodingLabel(value: unknown, argumentName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(argumentName, 'a non-empty encoding label', value);
  }
  try {
    new TextDecoder(value);
  } catch (error) {
    throw new SerialBrokerError(
      SerialBrokerErrorCode.INVALID_ARGUMENT,
      `${argumentName} is not an encoding this browser supports`,
      { context: { argumentName, label: value }, cause: error },
    );
  }
  return value;
}

/**
 * Decides whether two configurations may share a connection.
 *
 * Only the parts that reach the hardware count. Two tabs disagreeing about `decodeText` or
 * about reconnect timing is a local difference; disagreeing about the baud rate is a
 * conflict, because the port can only be opened one way.
 */
export function isDeviceCompatible(
  a: NormalizedConfiguration,
  b: NormalizedConfiguration,
): boolean {
  return (
    isSameDevice(a.device, b.device) &&
    a.serial.baudRate === b.serial.baudRate &&
    a.serial.dataBits === b.serial.dataBits &&
    a.serial.stopBits === b.serial.stopBits &&
    a.serial.parity === b.serial.parity &&
    a.serial.flowControl === b.serial.flowControl
  );
}

/** `true` if two filters name the same device. */
function isSameDevice(a: NormalizedDeviceFilter, b: NormalizedDeviceFilter): boolean {
  if (a.kind === 'any' || b.kind === 'any') {
    // Two "any" filters are compatible; an "any" and a USB filter are not, because one of
    // them would open a port the other did not ask for.
    return a.kind === b.kind;
  }
  return a.vendorId === b.vendorId && a.productId === b.productId;
}
