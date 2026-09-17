import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { BrowserHarness } from '../harness/browser-harness.js';
import { READER_OPTIONS, readerHarness } from '../harness/devices.js';

/** A connected tab, since every test here needs one. */
async function connectedTab(options: Record<string, unknown> = {}): Promise<{
  harness: BrowserHarness;
  device: ReturnType<BrowserHarness['serial']['addDevice']>;
  tab: ReturnType<BrowserHarness['openTab']>;
}> {
  const { harness, device } = readerHarness();
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

  it.each([
    ['raw bytes untouched', new Uint8Array([0x02, 0x41, 0x03]), [0x02, 0x41, 0x03]],
    ['an ArrayBuffer', new Uint8Array([1, 2]).buffer, [1, 2]],
    // A view carries an offset and a length. Sending its whole backing buffer would put four
    // bytes of somebody else's data on the wire.
    ['only the bytes a view spans', new Uint8Array([9, 9, 1, 2, 9, 9]).subarray(2, 4), [1, 2]],
  ] as const)('sends %s', async (_label, payload, expected) => {
    const { harness, device, tab } = await connectedTab();

    await tab.client.send('Reader', payload);
    await harness.settle();

    expect([...device.writtenBytes()]).toEqual(expected);
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

  it.each([
    [false, undefined],
    [true, 'hello'],
  ])('decodes text only when decodeText is %s', async (decodeText, expected) => {
    const { harness, device, tab } = await connectedTab({ encoding: { decodeText } });

    device.emit('hello');
    await harness.settle();

    expect(tab.recordFor('Reader').received[0]?.text).toBe(expected);
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
    // production (ADR-0013).
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

describe('text encoding labels', () => {
  it('keeps the canonical name, so strings can be sent whatever the label was spelled like', async () => {
    const { harness, device } = readerHarness();
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, encoding: { encoding: 'UTF8' } });

    await tab.client.send('Reader', 'PING');
    await harness.settle();

    expect(new TextDecoder().decode(device.written[0])).toBe('PING');
  });
});
