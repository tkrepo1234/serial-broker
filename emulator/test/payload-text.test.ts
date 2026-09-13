import { describe, expect, it } from 'vitest';

import { describeBytes, parseEscapedText } from '../src/payload-text.ts';

describe('parseEscapedText', () => {
  it('expands \\r, \\n, \\t, \\\\ and \\xHH escapes', () => {
    expect([...parseEscapedText('A\\r\\n\\t\\\\\\x02\\xFF')]).toEqual([
      0x41, 0x0d, 0x0a, 0x09, 0x5c, 0x02, 0xff,
    ]);
  });

  it('encodes everything else as UTF-8', () => {
    expect([...parseEscapedText('ü温')]).toEqual([0xc3, 0xbc, 0xe6, 0xb8, 0xa9]);
  });

  it('names a malformed escape instead of sending something the operator did not mean', () => {
    expect(() => parseEscapedText('\\xZZ')).toThrow('Malformed escape "\\xZZ".');
    expect(() => parseEscapedText('trailing\\')).toThrow(/Malformed escape/);
  });
});

describe('describeBytes', () => {
  it('shows printable ASCII as text and everything else as escapes', () => {
    expect(describeBytes(Uint8Array.of(0x4f, 0x4b, 0x0d, 0x0a, 0x00, 0x22))).toBe(
      '"OK\\r\\n\\x00\\""',
    );
  });

  it('writes every byte in a form parseEscapedText reads back, so a logged payload can be sent again', () => {
    const everyByte = Uint8Array.from({ length: 256 }, (_, byte) => byte);
    const described = describeBytes(everyByte, everyByte.length);

    expect([...parseEscapedText(described.slice(1, -1))]).toEqual([...everyByte]);
  });

  it('cuts a long payload and says how long it really was', () => {
    expect(describeBytes(new Uint8Array(100).fill(0x41), 3)).toBe('"AAA" … (100 bytes)');
  });
});
