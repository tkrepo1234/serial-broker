import { invalidArgument } from './validation.js';

/** What `send()` accepts as data, for the error that rejects anything else. */
const EXPECTED_DATA = 'a string, an ArrayBuffer or an ArrayBufferView';

/**
 * Copies a `BufferSource` into a fresh `Uint8Array`.
 *
 * Always a copy, never a view. Two reasons, both of which have bitten real libraries:
 * a `Uint8Array` handed to the application may be retained or mutated by it, and a view onto
 * a pooled buffer would change underneath both sides. See docs/guidelines/defensive-programming.md.
 *
 * @throws A `SerialBrokerError` with code `INVALID_ARGUMENT` if `source` is not a
 *   `BufferSource`, or its buffer has been detached.
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
    throw invalidArgument(argumentName, `${EXPECTED_DATA} whose buffer is not detached`, source, {
      cause: error,
      context: { detached: true },
    });
  }

  if (bytes !== undefined) {
    // `slice` on a Uint8Array always allocates a new, unshared ArrayBuffer - also for a view of a
    // SharedArrayBuffer, whose own `slice` would return shared memory again, which can neither be
    // posted to another context nor written to a port.
    return bytes.slice();
  }

  throw invalidArgument(argumentName, EXPECTED_DATA, source);
}

function isBuffer(value: unknown): value is ArrayBufferLike {
  const tag = Object.prototype.toString.call(value);
  return tag === '[object ArrayBuffer]' || tag === '[object SharedArrayBuffer]';
}

/** Formats bytes as space-separated uppercase hex, for `debug` log records. */
export function toHex(data: Uint8Array, maxBytes = 64): string {
  const shown = data.subarray(0, maxBytes);
  const hex = Array.from(shown, (byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(
    ' ',
  );
  return data.byteLength > maxBytes ? `${hex} ... (${String(data.byteLength)} bytes)` : hex;
}
