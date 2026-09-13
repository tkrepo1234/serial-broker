import type { ConnectionSettings, EncodingSettings, SerialSettings } from './types.js';

/** Effective serial settings, with every optional field resolved. */
export type NormalizedSerialSettings = Required<SerialSettings>;

/** Effective connection settings, with every optional field resolved. */
export type NormalizedConnectionSettings = Required<ConnectionSettings>;

/** Effective encoding settings, with every optional field resolved. */
export type NormalizedEncodingSettings = Required<EncodingSettings>;

/**
 * A validated, fully resolved configuration.
 *
 * Everything past the validation boundary works with this shape: no optional fields, no
 * defaults to re-apply, nothing to re-validate. See docs/guidelines/defensive-programming.md.
 */
/**
 * A validated device filter.
 *
 * Discriminated rather than "optional IDs", so that no code can read a vendor ID that a
 * configuration does not have. See ADR-0016.
 */
export type NormalizedDeviceFilter =
  | { readonly kind: 'usb'; readonly vendorId: number; readonly productId: number }
  | { readonly kind: 'any' };

export interface NormalizedConfiguration {
  readonly name: string;
  readonly device: NormalizedDeviceFilter;
  readonly serial: NormalizedSerialSettings;
  readonly connection: NormalizedConnectionSettings;
  readonly encoding: NormalizedEncodingSettings;
  readonly persist: boolean;
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

/** Longest accepted configuration name. Long enough for any real name, short enough to bound
 * the storage key and every log record. */
export const MAX_CONFIG_NAME_LENGTH = 128;
