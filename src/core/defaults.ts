import type { ConnectionSettings, EncodingSettings, SerialSettings } from './types.js';

/** Effective serial settings, with every optional field resolved. */
export type NormalizedSerialSettings = Required<SerialSettings>;

/** Effective connection settings, with every optional field resolved. */
export type NormalizedConnectionSettings = Required<ConnectionSettings>;

/** Effective encoding settings, with every optional field resolved. */
export type NormalizedEncodingSettings = Required<EncodingSettings>;

/** What auto mode resolves to: a USB identity, or the absence of one (ADR-0036). */
export type ResolvedDevice =
  | { readonly kind: 'usb'; readonly vendorId: number; readonly productId: number }
  | { readonly kind: 'non-usb' };

/**
 * A validated device filter.
 *
 * Discriminated rather than "optional IDs", so that no code can read a vendor ID that a
 * configuration does not have. See ADR-0016.
 *
 * `auto` keeps its resolution beside the mode rather than becoming the device it resolved to: the
 * configuration stays one that follows the tab holding the port, and a later `setup()` in auto
 * mode never conflicts with it (ADR-0036).
 */
export type NormalizedDeviceFilter =
  | ResolvedDevice
  | { readonly kind: 'any' }
  | { readonly kind: 'auto'; readonly resolved: ResolvedDevice | undefined };

/**
 * The device a filter matches ports against: the filter itself, or what auto mode resolved to.
 *
 * @returns `undefined` for an auto-mode filter that has not resolved, which matches nothing.
 */
export function effectiveDevice(
  filter: NormalizedDeviceFilter,
): ResolvedDevice | { readonly kind: 'any' } | undefined {
  return filter.kind === 'auto' ? filter.resolved : filter;
}

/**
 * A validated, fully resolved configuration.
 *
 * Everything past the validation boundary works with this shape: no optional fields, no
 * defaults to re-apply, nothing to re-validate. See docs/guidelines/defensive-programming.md.
 */
export interface NormalizedConfiguration {
  readonly name: string;
  readonly device: NormalizedDeviceFilter;
  readonly serial: NormalizedSerialSettings;
  readonly connection: NormalizedConnectionSettings;
  readonly encoding: NormalizedEncodingSettings;
  readonly persist: boolean;
  /** How many tabs may use the configuration at once; `Infinity` for no limit (ADR-0025). */
  readonly maxTabs: number;
}

/** Defaults for {@link SerialSettings}, matching the Web Serial dictionary defaults. */
export const DEFAULT_SERIAL_SETTINGS: Omit<NormalizedSerialSettings, 'baudRate'> = {
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  bufferSize: 255,
  flowControl: 'none',
};

/** Defaults for {@link ConnectionSettings}. Rationale for each value is in ADR-0010. */
export const DEFAULT_CONNECTION_SETTINGS: NormalizedConnectionSettings = {
  initialDelayMs: 250,
  factor: 2,
  maxDelayMs: 30_000,
  jitter: 0.5,
  maxAttempts: Number.POSITIVE_INFINITY,
  stableAfterMs: 5_000,
  openTimeoutMs: 10_000,
  writeTimeoutMs: 5_000,
  maxWriteChunkBytes: 4_096,
};

/** Defaults for {@link EncodingSettings}. See ADR-0015. */
export const DEFAULT_ENCODING_SETTINGS: NormalizedEncodingSettings = {
  encoding: 'utf-8',
  decodeText: false,
};

/** Default for {@link SerialBrokerOptions.persist}: remembered, so `restore()` brings it back. */
export const DEFAULT_PERSIST = true;

/** Default for {@link SerialBrokerOptions.maxTabs}: no limit. */
export const DEFAULT_MAX_TABS = Number.POSITIVE_INFINITY;

/** Longest accepted configuration name. Long enough for any real name, short enough to bound
 * the storage key and every log record. */
export const MAX_CONFIG_NAME_LENGTH = 128;
