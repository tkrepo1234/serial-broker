import { SerialBrokerErrorCode } from './error-codes.js';
import { SerialBrokerError } from './errors.js';

/**
 * Copies a `BufferSource` into a fresh `Uint8Array`.
 *
 * Always a copy, never a view. Two reasons, both of which have bitten real libraries:
 * a `Uint8Array` handed to the application may be retained or mutated by it, and a view onto
 * a pooled buffer would change underneath both sides. See docs/guidelines/defensive-programming.md.
 *
 * @throws A {@link SerialBrokerError} with code `INVALID_ARGUMENT` if `source` is not a
 *   `BufferSource`.
 */
export function copyBytes(source: BufferSource, argumentName = 'data'): Uint8Array {
  let bytes: Uint8Array | undefined;
  try {
    // A `DataView` or a `Uint16Array` contributes exactly the bytes it spans, not its whole
    // backing buffer. A buffer is recognised by its tag rather than by `instanceof`, which is false
    // for one made in another realm, such as an iframe.
    if (isBuffer(source)) {
      bytes = new Uint8Array(source);
    } else if (ArrayBuffer.isView(source)) {
      bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
  } catch (error) {
    // A view of a buffer that was transferred elsewhere cannot even be looked at.
    throw new SerialBrokerError(
      SerialBrokerErrorCode.INVALID_ARGUMENT,
      `${argumentName} cannot be read: its buffer has been transferred or detached`,
      { context: { argumentName, detached: true }, cause: error },
    );
  }

  if (bytes !== undefined) {
    // `slice` on a Uint8Array always allocates a new, unshared ArrayBuffer - also for a view of a
    // SharedArrayBuffer, whose own `slice` would return shared memory again, which can neither be
    // posted to another context nor written to a port.
    return bytes.slice();
  }

  throw new SerialBrokerError(
    SerialBrokerErrorCode.INVALID_ARGUMENT,
    `${argumentName} must be a string, an ArrayBuffer or an ArrayBufferView`,
    { context: { argumentName, actualType: typeof source } },
  );
}

function isBuffer(value: unknown): value is ArrayBufferLike {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/**
 * Splits a payload into chunks of at most `maxChunkBytes`.
 *
 * Devices with small receive buffers drop the tail of an oversized `write()` rather than
 * applying back-pressure. Each chunk is a view onto the same buffer - these are handed
 * straight to the writer and never escape the library, so no copy is warranted here.
 *
 * @returns One chunk for an empty payload as well, so that writing zero bytes remains an
 *   observable operation rather than a silent no-op.
 */
export function chunkBytes(data: Uint8Array, maxChunkBytes: number): readonly Uint8Array[] {
  if (data.byteLength <= maxChunkBytes) {
    return [data];
  }

  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += maxChunkBytes) {
    chunks.push(data.subarray(offset, Math.min(offset + maxChunkBytes, data.byteLength)));
  }
  return chunks;
}

/** Formats bytes as space-separated uppercase hex, for `debug` log records. */
export function toHex(data: Uint8Array, maxBytes = 64): string {
  const shown = data.subarray(0, maxBytes);
  const hex = Array.from(shown, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(
    ' ',
  );
  return data.byteLength > maxBytes ? `${hex} ... (${String(data.byteLength)} bytes)` : hex;
}
