import { describe, expect, it } from 'vitest';

import { chunkBytes, copyBytes } from '../../src/core/bytes.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/** A connected tab, since every test here needs one. */
async function connectedTab(options: Record<string, unknown> = {}): Promise<{
  harness: BrowserHarness;
  device: ReturnType<BrowserHarness['serial']['addDevice']>;
  tab: ReturnType<BrowserHarness['openTab']>;
}> {
  const harness = new BrowserHarness();
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const tab = harness.openTab();
  await tab.setup('Reader', { ...READER_OPTIONS, ...options });
  return { harness, device, tab };
}

describe('sending', () => {
  it('encodes a string as UTF-8 and appends nothing', async () => {
    const { harness, device, tab } = await connectedTab();

    await tab.client.send('Reader', 'STATUS?');
    await harness.settle();

    // No newline, no terminator, no framing: what the caller passes is what the device
    // receives (ADR-0002).
    expect([...device.writtenBytes()]).toEqual([...new TextEncoder().encode('STATUS?')]);
  });

  it('sends raw bytes untouched', async () => {
    const { harness, device, tab } = await connectedTab();

    await tab.client.send('Reader', new Uint8Array([0x02, 0x41, 0x03]));
    await harness.settle();

    expect([...device.writtenBytes()]).toEqual([0x02, 0x41, 0x03]);
  });

  it('accepts an ArrayBuffer', async () => {
    const { harness, device, tab } = await connectedTab();

    await tab.client.send('Reader', new Uint8Array([1, 2]).buffer);
    await harness.settle();

    expect([...device.writtenBytes()]).toEqual([1, 2]);
  });

  it('sends only the bytes a view spans', async () => {
    const { harness, device, tab } = await connectedTab();
    const backing = new Uint8Array([9, 9, 1, 2, 9, 9]);

    await tab.client.send('Reader', backing.subarray(2, 4));
    await harness.settle();

    // A view carries an offset and a length. Sending its whole backing buffer would put four
    // bytes of somebody else's data on the wire.
    expect([...device.writtenBytes()]).toEqual([1, 2]);
  });

  it('chunks a large payload, in order and complete', async () => {
    const { harness, device, tab } = await connectedTab({
      connection: { maxWriteChunkBytes: 16 },
    });
    const payload = new Uint8Array(100).map((_, index) => index % 251);

    await tab.client.send('Reader', payload);
    await harness.settle();

    // Devices with small receive buffers drop the tail of an oversized write rather than
    // applying back-pressure, so the chunking has to be complete and in order.
    expect(device.written.length).toBeGreaterThan(1);
    expect([...device.writtenBytes()]).toEqual([...payload]);
  });

  it('refuses a string when a non-UTF-8 encoding is configured', async () => {
    const { harness, device, tab } = await connectedTab({ encoding: { encoding: 'windows-1252' } });

    // TextEncoder only produces UTF-8. Silently sending the wrong bytes would present as a
    // device that misbehaves on umlauts, which is a miserable thing to debug.
    await expect(tab.client.send('Reader', 'Grüße')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
    });
    await harness.settle();
    expect(device.written).toHaveLength(0);
  });

  it('writes from one tab in the order that tab issued them', async () => {
    const { harness, device, tab } = await connectedTab();

    const writes = ['A', 'B', 'C', 'D'].map(
      async (command) => await tab.client.send('Reader', command),
    );
    await Promise.all(writes);
    await harness.settle();

    expect(device.writtenText()).toBe('ABCD');
  });
});

describe('receiving', () => {
  it('delivers bytes exactly as the device produced them', async () => {
    const { harness, device, tab } = await connectedTab();

    device.emit(new Uint8Array([0x02, 0xff, 0x03]));
    await harness.settle();

    expect([...(tab.recordFor('Reader').received[0]?.data ?? [])]).toEqual([0x02, 0xff, 0x03]);
  });

  it('delivers a copy the application may keep or mutate', async () => {
    const { harness, device, tab } = await connectedTab();

    device.emit(new Uint8Array([1, 2, 3]));
    await harness.settle();

    const received = tab.recordFor('Reader').received[0]?.data;
    received?.set([9, 9, 9]);
    device.emit(new Uint8Array([4]));
    await harness.settle();

    // If the library handed out a view onto its own buffer, this mutation would have changed
    // what the next listener sees, or what a peer tab receives.
    expect([...(tab.recordFor('Reader').received[1]?.data ?? [])]).toEqual([4]);
  });

  it('omits text when decoding is not enabled', async () => {
    const { harness, device, tab } = await connectedTab();

    device.emit('hello');
    await harness.settle();

    expect(tab.recordFor('Reader').received[0]?.text).toBeUndefined();
  });

  it('decodes text when asked to', async () => {
    const { harness, device, tab } = await connectedTab({ encoding: { decodeText: true } });

    device.emit('hello');
    await harness.settle();

    expect(tab.recordFor('Reader').received[0]?.text).toBe('hello');
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    const { harness, device, tab } = await connectedTab({ encoding: { decodeText: true } });
    const euro = new TextEncoder().encode('€');

    device.emit(euro.subarray(0, 1));
    await harness.settle();
    device.emit(euro.subarray(1));
    await harness.settle();

    // The trap this feature exists to avoid: a per-chunk decoder produces replacement
    // characters here, and only ever on non-ASCII input, so it survives testing and breaks in
    // production (ADR-0015).
    const decoded = tab
      .recordFor('Reader')
      .received.map((event) => event.text ?? '')
      .join('');
    expect(decoded).toBe('€');
  });

  it('delivers decoded text to peer tabs as well', async () => {
    const { harness, device, tab } = await connectedTab({ encoding: { decodeText: true } });
    const peer = harness.openTab();
    await peer.setup('Reader', { ...READER_OPTIONS, encoding: { decodeText: true } });

    device.emit('shared');
    await harness.settle();

    expect(tab.recordFor('Reader').received[0]?.text).toBe('shared');
    expect(peer.recordFor('Reader').received[0]?.text).toBe('shared');
  });

  it('does not carry a partial character across a reconnect', async () => {
    const { harness, device, tab } = await connectedTab({ encoding: { decodeText: true } });
    const euro = new TextEncoder().encode('€');

    device.emit(euro.subarray(0, 1));
    await harness.settle();
    harness.serial.unplug(device);
    await harness.settle();
    harness.serial.plug(device);
    await harness.settle();
    device.emit('OK');
    await harness.settle();

    // A character cannot span a disconnect, so neither may the decoder's state: the orphaned
    // lead byte must not corrupt the first text seen after the device comes back. A decoder that
    // kept it would turn that text into a replacement character followed by "OK".
    const received = tab.recordFor('Reader').received;
    expect(received.at(-1)?.text).toBe('OK');
    expect(received.map((event) => event.text ?? '').join('')).not.toContain('€');
  });
});

describe('byte helpers', () => {
  it('copies rather than aliasing', () => {
    const source = new Uint8Array([1, 2, 3]);
    const copy = copyBytes(source);

    source[0] = 9;

    expect([...copy]).toEqual([1, 2, 3]);
  });

  it('copies only the bytes a DataView spans', () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const view = new DataView(backing.buffer, 2, 2);

    expect([...copyBytes(view)]).toEqual([3, 4]);
  });

  it('rejects something that is not a buffer', () => {
    expect(() => copyBytes(42 as unknown as BufferSource)).toThrow(SerialBrokerError);
  });

  it('returns one chunk for a payload that fits', () => {
    expect(chunkBytes(new Uint8Array([1, 2]), 10)).toHaveLength(1);
  });

  it('returns one chunk for an empty payload, so writing nothing stays observable', () => {
    expect(chunkBytes(new Uint8Array(0), 10)).toHaveLength(1);
  });

  it('splits on the configured boundary', () => {
    const chunks = chunkBytes(new Uint8Array(10), 4);

    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([4, 4, 2]);
  });
});
