import { assertNever } from './assert.js';
import {
  DEFAULT_MAX_TABS,
  DEFAULT_CONNECTION_SETTINGS,
  DEFAULT_ENCODING_SETTINGS,
  DEFAULT_RECEIVE_SETTINGS,
  DEFAULT_REMEMBER,
  DEFAULT_SERIAL_SETTINGS,
  MAX_CONFIG_NAME_LENGTH,
  type NormalizedConfiguration,
  type NormalizedConnectionSettings,
  type NormalizedDeviceFilter,
  type NormalizedSerialSettings,
  type ResolvedDevice,
} from './defaults.js';
import type { EffectiveSettings } from './diagnostics.js';
import { SerialBrokerErrorCode } from './error-codes.js';
import { SerialBrokerError } from './errors.js';
import type {
  DeviceFilter,
  ResolvedDeviceFilter,
  SerialBrokerGlobalOptions,
  TransportKind,
} from './types.js';

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

/**
 * The highest baud rate accepted. Generous rather than authoritative: the set of supported rates
 * is a property of the adapter, not of this library, and rejecting an unusual but valid rate would
 * be worse than letting `open()` report it.
 */
const MAX_BAUD_RATE = 20_000_000;

/** The largest buffer or chunk size accepted: 16 MiB, the largest read buffer Chromium allocates. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** The longest reconnect delay accepted: an hour. */
const MAX_DELAY_MS = 3_600_000;

/** The longest open or write deadline accepted: ten minutes. */
const MAX_TIMEOUT_MS = 600_000;

/** The most reconnect attempts accepted other than `Infinity`. */
const MAX_ATTEMPTS = 1_000_000;

/**
 * The largest tab limit other than `Infinity`.
 *
 * A tab waiting for a place requests every place at once (ADR-0017), so the limit is a number of
 * Web Lock requests. A hundred tabs is more than any application uses one device from.
 */
const MAX_TAB_LIMIT = 100;

/**
 * Builds an `INVALID_ARGUMENT` error naming the offending argument and what was expected.
 *
 * Every argument rejection goes through here, so `context` always has the shape
 * docs/site/errors.md documents: `argumentName`, `expected`, `actualType` and, for a simple value,
 * `actualValue`.
 *
 * @param options - `cause`, where something other than this module rejected the value, and
 *   `context` to add to the documented fields.
 */
export function invalidArgument(
  argumentName: string,
  expected: string,
  actual: unknown,
  options: {
    readonly cause?: unknown;
    readonly context?: Readonly<Record<string, unknown>>;
    readonly configName?: string;
  } = {},
): SerialBrokerError {
  return new SerialBrokerError(
    SerialBrokerErrorCode.INVALID_ARGUMENT,
    `${argumentName} must be ${expected}`,
    {
      context: {
        ...options.context,
        argumentName,
        expected,
        actualType: actual === null ? 'null' : typeof actual,
        actualValue: isLoggableValue(actual) ? actual : undefined,
      },
      cause: options.cause,
      configName: options.configName,
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
    throw invalidArgument(argumentName, 'a string', name);
  }
  if (name.length === 0) {
    throw invalidArgument(argumentName, 'a non-empty string', name);
  }
  if (name.length > MAX_CONFIG_NAME_LENGTH) {
    throw invalidArgument(
      argumentName,
      `at most ${String(MAX_CONFIG_NAME_LENGTH)} characters`,
      name.length,
    );
  }
  // Control characters - C0, DEL and C1 - would corrupt the Web Lock name, the storage key and
  // every log record this name appears in. Checked by code unit rather than by regular expression
  // so the intent is readable without decoding escapes.
  for (let index = 0; index < name.length; index += 1) {
    const codeUnit = name.charCodeAt(index);
    if (codeUnit < 0x20 || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      throw invalidArgument(argumentName, 'free of control characters', name);
    }
  }
  // An unpaired surrogate becomes U+FFFD wherever the name is encoded as UTF-8, as a Web Lock name
  // is on its way to the browser: two different names could then share one ownership lock.
  if (hasUnpairedSurrogate(name)) {
    throw invalidArgument(argumentName, 'well-formed Unicode, without unpaired surrogates', name);
  }
  return name;
}

function hasUnpairedSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return true;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function requireInteger(value: unknown, argumentName: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw invalidArgument(argumentName, 'an integer', value);
  }
  if (value < min || value > max) {
    throw invalidArgument(
      argumentName,
      `an integer between ${String(min)} and ${String(max)}`,
      value,
    );
  }
  return value;
}

/**
 * An integer in range, or `Infinity` for "no limit".
 *
 * `maxAttempts` and `maxTabs` both default to `Infinity`, so both must accept it - and both say so
 * when they reject a value, or the message would contradict the documented default.
 */
function requireIntegerOrInfinity(
  value: unknown,
  argumentName: string,
  min: number,
  max: number,
): number {
  if (value === Number.POSITIVE_INFINITY) {
    return value;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidArgument(
      argumentName,
      `an integer between ${String(min)} and ${String(max)}, or Infinity`,
      value,
    );
  }
  return value;
}

function requireFiniteNumber(
  value: unknown,
  argumentName: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidArgument(argumentName, 'a finite number', value);
  }
  if (value < min || value > max) {
    throw invalidArgument(argumentName, `between ${String(min)} and ${String(max)}`, value);
  }
  return value;
}

function requireOneOf<T extends string | number>(
  value: unknown,
  argumentName: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T)) {
    throw invalidArgument(argumentName, `one of ${allowed.map(String).join(', ')}`, value);
  }
  return value as T;
}

function requireBoolean(value: unknown, argumentName: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidArgument(argumentName, 'a boolean', value);
  }
  return value;
}

/**
 * An option's value, or its default when it is absent.
 *
 * Only `undefined` means absent. `null` is passed on, and fails validation like any other value
 * of the wrong type: nothing is coerced silently.
 */
function orDefault(value: unknown, fallback: unknown): unknown {
  return value === undefined ? fallback : value;
}

function requireObject(value: unknown, argumentName: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArgument(argumentName, 'an object', value);
  }
  return value as Record<string, unknown>;
}

/** Like {@link requireObject}, for an optional group of options: absent means all defaults. */
function optionalObject(value: unknown, argumentName: string): Record<string, unknown> {
  return value === undefined ? {} : requireObject(value, argumentName);
}

/** What `options.device` may be, quoted when a mixture of shapes is rejected. */
const DEVICE_SHAPES =
  'one of { vendorId, productId }, { any: true }, { nonUsb: true } or { auto: true }, not a mixture';

/**
 * Validates a device filter.
 *
 * Four shapes, kept apart rather than merged into one with optional IDs: a configuration
 * identifies a USB device, accepts whatever the user granted, accepts only ports without a USB
 * identity, or takes its device from the port the user chooses - and code downstream must not be
 * able to read a vendor ID from a kind that has none. See ADR-0022.
 *
 * Mixing them - passing `any` *and* IDs, say - is rejected rather than silently resolved, because
 * either interpretation would be a guess about what the caller meant. An absent `device` is auto
 * mode; an empty object is not, because it names the USB shape without its IDs.
 *
 * @param device - `options.device`, or `undefined` when it was omitted.
 */
function normalizeDeviceFilter(device: unknown): NormalizedDeviceFilter {
  if (device === undefined) {
    return Object.freeze({ kind: 'auto' as const, resolved: undefined });
  }
  const raw = requireObject(device, 'options.device');

  // Each field is read once. An options object may be a proxy or carry getters, and a value that
  // passed a check must be the value that is kept.
  const wantsAuto = raw['auto'];
  const wantsAny = raw['any'];
  const wantsNonUsb = raw['nonUsb'];
  const vendorId = raw['vendorId'];
  const productId = raw['productId'];
  const resolved = raw['resolved'];

  for (const [flag, value] of [
    ['auto', wantsAuto],
    ['any', wantsAny],
    ['nonUsb', wantsNonUsb],
  ] as const) {
    if (value !== undefined && value !== true) {
      throw invalidArgument(`options.device.${flag}`, 'true, or absent', value);
    }
  }
  const shapes = [
    wantsAuto,
    wantsAny,
    wantsNonUsb,
    vendorId !== undefined || productId !== undefined ? true : undefined,
  ].filter((shape) => shape !== undefined).length;
  if (shapes > 1 || (resolved !== undefined && wantsAuto === undefined)) {
    throw invalidArgument('options.device', DEVICE_SHAPES, raw);
  }

  if (wantsAuto === true) {
    return Object.freeze({
      kind: 'auto' as const,
      resolved: resolved === undefined ? undefined : normalizeResolvedDevice(resolved),
    });
  }
  if (wantsAny === true) {
    return Object.freeze({ kind: 'any' as const });
  }
  if (wantsNonUsb === true) {
    return Object.freeze({ kind: 'non-usb' as const });
  }
  return normalizeUsbDevice(vendorId, productId, 'options.device');
}

/**
 * Validates what an auto-mode filter has resolved to: a USB identity or `{ nonUsb: true }`.
 *
 * Neither `any` nor `auto` can be a resolution - a port the user chose has an identity or has
 * none - so they are rejected here like any other value.
 */
function normalizeResolvedDevice(resolved: unknown): ResolvedDevice {
  const argumentName = 'options.device.resolved';
  const raw = requireObject(resolved, argumentName);
  const wantsNonUsb = raw['nonUsb'];
  const vendorId = raw['vendorId'];
  const productId = raw['productId'];

  if (wantsNonUsb !== undefined) {
    if (wantsNonUsb !== true) {
      throw invalidArgument(`${argumentName}.nonUsb`, 'true, or absent', wantsNonUsb);
    }
    if (vendorId !== undefined || productId !== undefined) {
      throw invalidArgument(
        argumentName,
        'either { vendorId, productId } or { nonUsb: true }, not both',
        raw,
      );
    }
    return Object.freeze({ kind: 'non-usb' as const });
  }
  return normalizeUsbDevice(vendorId, productId, argumentName);
}

function normalizeUsbDevice(
  vendorId: unknown,
  productId: unknown,
  argumentName: string,
): ResolvedDevice {
  return Object.freeze({
    kind: 'usb' as const,
    vendorId: requireInteger(vendorId, `${argumentName}.vendorId`, 0, USB_ID_MAX),
    productId: requireInteger(productId, `${argumentName}.productId`, 0, USB_ID_MAX),
  });
}

/**
 * Validates the options passed to `release()` and `releaseAll()`.
 *
 * Read once, before anything is released: a value that fails must leave the configuration running,
 * and one read again after the port has closed could have changed in between.
 *
 * Both options default to `false`, so a release on its own keeps what is remembered and the
 * browser's permission alike (ADR-0020).
 *
 * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT`.
 */
export function normalizeReleaseOptions(options: unknown): {
  readonly forget: boolean;
  readonly forgetDevice: boolean;
} {
  const raw = optionalObject(options, 'options');
  return Object.freeze({
    forget: requireBoolean(orDefault(raw['forget'], false), 'options.forget'),
    forgetDevice: requireBoolean(orDefault(raw['forgetDevice'], false), 'options.forgetDevice'),
  });
}

/**
 * Validates the options passed to `requestAccess()`, before the picker is opened.
 *
 * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT`.
 */
export function normalizeRequestAccessOptions(options: unknown): {
  readonly chooseAgain: boolean;
} {
  const raw = optionalObject(options, 'options');
  return Object.freeze({
    chooseAgain: requireBoolean(orDefault(raw['chooseAgain'], false), 'options.chooseAgain'),
  });
}

const TRANSPORT_KINDS: readonly TransportKind[] = ['auto', 'sharedworker', 'broadcastchannel'];

/**
 * Validates the options passed to `configure()`, and copies them.
 *
 * Each option is read once, and only the documented ones are kept, so the settings a client is
 * built with later are the ones checked now. `undefined` sets an option back to its default.
 *
 * `logPayloads` in particular must be a boolean: a truthy string would otherwise switch payload
 * bytes into the log.
 *
 * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT`.
 */
export function normalizeGlobalOptions(options: unknown): SerialBrokerGlobalOptions {
  const raw = requireObject(options, 'options');
  const workerUrl = raw['workerUrl'];
  const transport = raw['transport'];
  const logger = raw['logger'];
  const logPayloads = raw['logPayloads'];
  const result: Record<string, unknown> = {};

  if ('workerUrl' in raw) {
    if (
      workerUrl !== undefined &&
      !(typeof workerUrl === 'string' && workerUrl.length > 0) &&
      !isUrl(workerUrl)
    ) {
      throw invalidArgument('options.workerUrl', 'a non-empty string or a URL', workerUrl);
    }
    result['workerUrl'] = workerUrl;
  }
  if ('transport' in raw) {
    result['transport'] =
      transport === undefined
        ? undefined
        : requireOneOf(transport, 'options.transport', TRANSPORT_KINDS);
  }
  if ('logger' in raw) {
    if (logger !== undefined) {
      const log = typeof logger === 'object' && logger !== null ? readLog(logger) : undefined;
      if (typeof log !== 'function') {
        throw invalidArgument(
          'options.logger',
          'an object with a log(level, message, fields) method',
          logger,
        );
      }
    }
    result['logger'] = logger;
  }
  if ('logPayloads' in raw) {
    result['logPayloads'] =
      logPayloads === undefined ? undefined : requireBoolean(logPayloads, 'options.logPayloads');
  }
  return result;
}

/** A `URL`, recognised by its tag, so one from another realm counts too. */
function isUrl(value: unknown): value is URL {
  return Object.prototype.toString.call(value) === '[object URL]';
}

function readLog(logger: object): unknown {
  return (logger as { log?: unknown }).log;
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
  const raw = requireObject(options, 'options');

  const device = raw['device'];
  const serial = requireObject(raw['serial'], 'options.serial');
  const connection = optionalObject(raw['connection'], 'options.connection');
  const encoding = optionalObject(raw['encoding'], 'options.encoding');
  const receive = optionalObject(raw['receive'], 'options.receive');

  // Each option is read with its default and its full argument name in one place, so the name a
  // rejection reports cannot drift from the field that was read.
  const serialOption = (key: keyof Omit<NormalizedSerialSettings, 'baudRate'>) =>
    [orDefault(serial[key], DEFAULT_SERIAL_SETTINGS[key]), `options.serial.${key}`] as const;
  const connectionOption = (key: keyof NormalizedConnectionSettings) =>
    [
      orDefault(connection[key], DEFAULT_CONNECTION_SETTINGS[key]),
      `options.connection.${key}`,
    ] as const;

  return Object.freeze({
    name: validName,
    device: normalizeDeviceFilter(device),
    serial: Object.freeze({
      baudRate: requireInteger(serial['baudRate'], 'options.serial.baudRate', 1, MAX_BAUD_RATE),
      dataBits: requireOneOf(...serialOption('dataBits'), VALID_DATA_BITS) as 7 | 8,
      stopBits: requireOneOf(...serialOption('stopBits'), VALID_STOP_BITS) as 1 | 2,
      parity: requireOneOf(...serialOption('parity'), VALID_PARITY) as 'none' | 'even' | 'odd',
      bufferSize: requireInteger(...serialOption('bufferSize'), 1, MAX_BUFFER_BYTES),
      flowControl: requireOneOf(...serialOption('flowControl'), VALID_FLOW_CONTROL) as
        'none' | 'hardware',
    }),
    connection: Object.freeze({
      initialDelayMs: requireInteger(...connectionOption('initialDelayMs'), 0, MAX_DELAY_MS),
      factor: requireFiniteNumber(...connectionOption('factor'), 1, 100),
      maxDelayMs: requireInteger(...connectionOption('maxDelayMs'), 0, MAX_DELAY_MS),
      jitter: requireFiniteNumber(...connectionOption('jitter'), 0, 1),
      // From one, not from zero: an attempt is always made. `maxAttempts: 0` reads as "do not
      // reconnect", which `autoReconnect: false` says (ADR-0008), and would still make one attempt.
      maxAttempts: requireIntegerOrInfinity(...connectionOption('maxAttempts'), 1, MAX_ATTEMPTS),
      stableAfterMs: requireInteger(...connectionOption('stableAfterMs'), 0, MAX_DELAY_MS),
      openTimeoutMs: requireInteger(...connectionOption('openTimeoutMs'), 1, MAX_TIMEOUT_MS),
      writeTimeoutMs: requireInteger(...connectionOption('writeTimeoutMs'), 1, MAX_TIMEOUT_MS),
      maxWriteChunkBytes: requireInteger(
        ...connectionOption('maxWriteChunkBytes'),
        1,
        MAX_BUFFER_BYTES,
      ),
      autoReconnect: requireBoolean(...connectionOption('autoReconnect')),
    }),
    receive: Object.freeze({
      idleMs: requireInteger(
        orDefault(receive['idleMs'], DEFAULT_RECEIVE_SETTINGS.idleMs),
        'options.receive.idleMs',
        0,
        MAX_DELAY_MS,
      ),
      maxWaitMs: requireInteger(
        orDefault(receive['maxWaitMs'], DEFAULT_RECEIVE_SETTINGS.maxWaitMs),
        'options.receive.maxWaitMs',
        1,
        MAX_DELAY_MS,
      ),
    }),
    encoding: Object.freeze({
      encoding: validateEncodingLabel(
        orDefault(encoding['encoding'], DEFAULT_ENCODING_SETTINGS.encoding),
        'options.encoding.encoding',
      ),
      decodeText: requireBoolean(
        orDefault(encoding['decodeText'], DEFAULT_ENCODING_SETTINGS.decodeText),
        'options.encoding.decodeText',
      ),
    }),
    remember: requireBoolean(orDefault(raw['remember'], DEFAULT_REMEMBER), 'options.remember'),
    maxTabs: requireIntegerOrInfinity(
      orDefault(raw['maxTabs'], DEFAULT_MAX_TABS),
      'options.maxTabs',
      1,
      MAX_TAB_LIMIT,
    ),
  });
}

/**
 * Turns a normalised configuration back into the options `setup()` accepts.
 *
 * The inverse of {@link normalizeConfiguration}, and the one place the device filter is turned
 * back into its application-facing shape. A configuration leaves the validated core this way
 * wherever it goes: restored through `setup()`, written to storage, described in a diagnostics
 * report (ADR-0014). Each nested object is a copy, so the result can be changed or cloned without
 * touching the frozen original.
 *
 * @param configuration - A configuration that has passed validation.
 * @returns Options that `normalizeConfiguration` turns back into an equal configuration.
 */
export function toSetupOptions(configuration: NormalizedConfiguration): EffectiveSettings {
  return {
    device: toDeviceOptions(configuration.device),
    serial: { ...configuration.serial },
    connection: { ...configuration.connection },
    encoding: { ...configuration.encoding },
    receive: { ...configuration.receive },
    remember: configuration.remember,
    maxTabs: configuration.maxTabs,
  };
}

/** The application-facing shape of a validated device filter, resolution included. */
function toDeviceOptions(device: NormalizedDeviceFilter): DeviceFilter {
  switch (device.kind) {
    case 'usb':
      return { vendorId: device.vendorId, productId: device.productId };
    case 'non-usb':
      return { nonUsb: true };
    case 'any':
      return { any: true };
    case 'auto':
      // The key is left out rather than set to `undefined`, so that the stored entry and a
      // diagnostics report say `{ auto: true }` for a configuration that has not resolved.
      return device.resolved === undefined
        ? { auto: true }
        : { auto: true, resolved: toDeviceOptions(device.resolved) as ResolvedDeviceFilter };
    default:
      return assertNever(device, 'device filter');
  }
}

/**
 * Checks that an encoding label is one `TextDecoder` will accept, and returns its canonical name.
 *
 * Verified eagerly rather than at first use: an unknown label would otherwise surface as a
 * `RangeError` from deep inside the owning tab's read loop, minutes after the mistake. The
 * canonical name - `utf-8` for `UTF-8`, `utf8` or `unicode-1-1-utf-8` - is what every later
 * comparison sees, so a label spelled differently cannot behave differently.
 */
function validateEncodingLabel(value: unknown, argumentName: string): string {
  const expected = 'an encoding label that TextDecoder accepts';
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidArgument(argumentName, expected, value);
  }
  try {
    return new TextDecoder(value).encoding;
  } catch (error) {
    throw invalidArgument(argumentName, expected, value, { cause: error });
  }
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
    a.serial.bufferSize === b.serial.bufferSize &&
    a.serial.dataBits === b.serial.dataBits &&
    a.serial.stopBits === b.serial.stopBits &&
    a.serial.parity === b.serial.parity &&
    a.serial.flowControl === b.serial.flowControl &&
    // Not a hardware setting, but a second `setup()` cannot change it either: the tab already
    // holds, or waits for, a place among a set of that size (ADR-0017).
    a.maxTabs === b.maxTabs
  );
}

/**
 * `true` if two filters name the same device.
 *
 * Auto mode never conflicts with auto mode: both say "whatever the tab holding the port chose",
 * and the session already running keeps its resolution (ADR-0022). Against an explicit filter, an
 * auto-mode filter that has not resolved is compatible - it has committed to nothing - and one
 * that has resolved counts as the device it resolved to.
 */
function isSameDevice(a: NormalizedDeviceFilter, b: NormalizedDeviceFilter): boolean {
  if (a.kind === 'auto') {
    return b.kind === 'auto' || a.resolved === undefined || isSameExplicitDevice(a.resolved, b);
  }
  if (b.kind === 'auto') {
    return b.resolved === undefined || isSameExplicitDevice(a, b.resolved);
  }
  return isSameExplicitDevice(a, b);
}

/** A filter that names its device outright: everything but auto mode. */
type ExplicitDeviceFilter = Exclude<NormalizedDeviceFilter, { readonly kind: 'auto' }>;

function isSameExplicitDevice(a: ExplicitDeviceFilter, b: ExplicitDeviceFilter): boolean {
  if (a.kind !== b.kind) {
    // Two `any` filters are compatible, as are two non-USB ones; filters of different kinds are
    // not, because one of them would open a port the other did not ask for.
    return false;
  }
  return (
    a.kind !== 'usb' ||
    b.kind !== 'usb' ||
    (a.vendorId === b.vendorId && a.productId === b.productId)
  );
}
