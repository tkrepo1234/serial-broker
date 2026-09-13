/**
 * Conversions between what an operator types and the bytes on the wire.
 */

const SIMPLE_ESCAPES = new Map([
  ['r', '\r'],
  ['n', '\n'],
  ['t', '\t'],
  ['\\', '\\'],
  // describeBytes writes a quote as \" so that the quotes around a payload stay unambiguous.
  // Accepting the same escape here is what lets an operator copy a logged payload into `send`.
  ['"', '"'],
]);

const NAMED_BYTES = new Map([
  [0x0d, '\\r'],
  [0x0a, '\\n'],
  [0x09, '\\t'],
  [0x5c, '\\\\'],
  [0x22, '\\"'],
]);

/**
 * Turns operator input into bytes, honouring `\r`, `\n`, `\t`, `\\`, `\"` and `\xHH` escapes.
 *
 * Everything else is encoded as UTF-8, so `send Grüße` sends the two-byte `ü` a real device
 * would receive from a UTF-8 host.
 *
 * @param text - The input, escapes unexpanded.
 * @returns The bytes to send.
 * @throws An `Error` naming the offending escape if one is malformed.
 */
export function parseEscapedText(text: string): Uint8Array {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let literal = '';
  const flushLiteral = (): void => {
    bytes.push(...encoder.encode(literal));
    literal = '';
  };

  for (let position = 0; position < text.length; position += 1) {
    const character = text.charAt(position);
    if (character !== '\\') {
      literal += character;
      continue;
    }
    const escape = text.charAt(position + 1);
    const simple = SIMPLE_ESCAPES.get(escape);
    if (simple !== undefined) {
      literal += simple;
      position += 1;
      continue;
    }
    const hex = text.slice(position + 2, position + 4);
    if (escape !== 'x' || !/^[0-9a-fA-F]{2}$/.test(hex)) {
      throw new Error(`Malformed escape "${text.slice(position, position + 4)}".`);
    }
    flushLiteral();
    bytes.push(Number.parseInt(hex, 16));
    position += 3;
  }
  flushLiteral();
  return Uint8Array.from(bytes);
}

/**
 * Renders bytes for the operator's log: printable ASCII as text, everything else as `\xHH`.
 *
 * The inverse of {@link parseEscapedText}: the text between the quotes, typed after `send`,
 * produces the same bytes again.
 *
 * @param bytes - The payload.
 * @param maxBytes - Longer payloads are cut here and marked with their full length.
 * @returns A single line.
 */
export function describeBytes(bytes: Uint8Array, maxBytes = 80): string {
  let rendered = '';
  for (const byte of bytes.subarray(0, maxBytes)) {
    const named = NAMED_BYTES.get(byte);
    if (named !== undefined) {
      rendered += named;
    } else if (byte >= 0x20 && byte < 0x7f) {
      rendered += String.fromCharCode(byte);
    } else {
      rendered += `\\x${byte.toString(16).padStart(2, '0')}`;
    }
  }
  const suffix = bytes.length > maxBytes ? ` … (${String(bytes.length)} bytes)` : '';
  return `"${rendered}"${suffix}`;
}
