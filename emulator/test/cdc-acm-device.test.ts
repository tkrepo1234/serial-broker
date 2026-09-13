import { describe, expect, it } from 'vitest';

import { CdcAcmDevice } from '../src/cdc-acm-device.ts';
import type { DeviceEvent, UrbResult } from '../src/cdc-acm-device.ts';
import type { SubmitCommand } from '../src/usbip-protocol.ts';

const IDENTITY = {
  vendorId: 0x1209,
  productId: 0x0001,
  manufacturer: 'serial-broker',
  product: 'test device',
  serialNumber: 'TEST-1',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function control(
  seqnum: number,
  requestType: number,
  request: number,
  value: number,
  length: number,
  data: readonly number[] = [],
): SubmitCommand {
  const isIn = (requestType & 0x80) !== 0;
  return {
    kind: 'submit',
    seqnum,
    direction: isIn ? 'in' : 'out',
    endpointNumber: 0,
    transferBufferLength: isIn ? length : data.length,
    setup: { requestType, request, value, index: 0, length },
    data: Uint8Array.from(data),
  };
}

function bulkOut(seqnum: number, text: string): SubmitCommand {
  const data = encoder.encode(text);
  return {
    kind: 'submit',
    seqnum,
    direction: 'out',
    endpointNumber: 2,
    transferBufferLength: data.length,
    setup: { requestType: 0, request: 0, value: 0, index: 0, length: 0 },
    data,
  };
}

function read(seqnum: number, length: number, endpointNumber = 2): SubmitCommand {
  return {
    kind: 'submit',
    seqnum,
    direction: 'in',
    endpointNumber,
    transferBufferLength: length,
    setup: { requestType: 0, request: 0, value: 0, index: 0, length: 0 },
    data: new Uint8Array(0),
  };
}

function attachedDevice(): { device: CdcAcmDevice; results: UrbResult[]; events: DeviceEvent[] } {
  const events: DeviceEvent[] = [];
  const results: UrbResult[] = [];
  const device = new CdcAcmDevice(IDENTITY, (event) => events.push(event));
  device.attach((result) => results.push(result));
  return { device, results, events };
}

function textOf(result: UrbResult | undefined): string {
  return decoder.decode(result?.data);
}

describe('CdcAcmDevice control requests', () => {
  it('answers GET_DESCRIPTOR for the device descriptor, never with more than the host asked for', () => {
    const { device, results } = attachedDevice();

    device.submit(control(1, 0x80, 0x06, 0x0100, 8));

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe(0);
    expect(results[0]?.actualLength).toBe(8);
    expect(results[0]?.data[0]).toBe(18);
  });

  it('stalls a request for a device qualifier, which a full-speed device does not have', () => {
    const { device, results } = attachedDevice();

    device.submit(control(1, 0x80, 0x06, 0x0600, 10));

    expect(results[0]?.status).toBe(-32);
  });

  it('stores the line coding the host sets and reports it back unchanged', () => {
    const { device, results, events } = attachedDevice();
    const lineCoding = [0x00, 0xc2, 0x01, 0x00, 0x02, 0x02, 0x07]; // 115200, 2 stop, even, 7 bits

    device.submit(control(1, 0x21, 0x20, 0, 7, lineCoding));
    device.submit(control(2, 0xa1, 0x21, 0, 7));

    expect(results[0]?.status).toBe(0);
    expect([...(results[1]?.data ?? [])]).toEqual(lineCoding);
    expect(events).toContainEqual({
      kind: 'line-coding',
      lineCoding: { baudRate: 115200, stopBits: 2, parity: 'even', dataBits: 7 },
    });
  });

  it('stalls a line coding that is shorter than seven bytes or names an unknown parity', () => {
    const { device, results } = attachedDevice();

    device.submit(control(1, 0x21, 0x20, 0, 3, [0x80, 0x25, 0x00]));
    device.submit(control(2, 0x21, 0x20, 0, 7, [0x80, 0x25, 0x00, 0x00, 0x00, 0x09, 0x08]));

    expect(results.map((result) => result.status)).toEqual([-32, -32]);
    expect(device.status().lineCoding.baudRate).toBe(9600);
  });

  it('reports DTR and RTS as SET_CONTROL_LINE_STATE sets them', () => {
    const { device, events } = attachedDevice();

    device.submit(control(1, 0x21, 0x22, 0x0001, 0));

    expect(events).toContainEqual({ kind: 'control-lines', isDtrSet: true, isRtsSet: false });
    expect(device.status().isDtrSet).toBe(true);
  });

  it('accepts configuration 1, reports it back, and stalls a configuration it does not have', () => {
    const { device, results } = attachedDevice();

    device.submit(control(1, 0x00, 0x09, 1, 0));
    device.submit(control(2, 0x80, 0x08, 0, 1));
    device.submit(control(3, 0x00, 0x09, 2, 0));

    expect(results[0]?.status).toBe(0);
    expect([...(results[1]?.data ?? [])]).toEqual([1]);
    expect(results[2]?.status).toBe(-32);
  });

  it('stalls a vendor request', () => {
    const { device, results } = attachedDevice();

    device.submit(control(1, 0xc0, 0x01, 0, 4));

    expect(results[0]?.status).toBe(-32);
  });
});

describe('CdcAcmDevice data', () => {
  it('returns written bytes to a read that was already waiting, after completing the write', () => {
    const { device, results } = attachedDevice();

    device.submit(read(1, 64));
    device.submit(bulkOut(2, 'HELLO'));

    expect(results.map((result) => result.seqnum)).toEqual([2, 1]);
    expect(results[0]?.actualLength).toBe(5);
    expect(textOf(results[1])).toBe('HELLO');
  });

  it('keeps returned bytes until the host reads them', () => {
    const { device, results } = attachedDevice();

    device.submit(bulkOut(1, 'LATER'));
    device.submit(read(2, 64));

    expect(results.map((result) => result.seqnum)).toEqual([1, 2]);
    expect(textOf(results[1])).toBe('LATER');
  });

  it('splits returned bytes across reads that are shorter than the payload, in order', () => {
    const { device, results } = attachedDevice();

    device.submit(bulkOut(1, 'ABCDEFG'));
    device.submit(bulkOut(2, 'HI'));
    device.submit(read(3, 4));
    device.submit(read(4, 4));
    device.submit(read(5, 4));

    expect(results.slice(2).map(textOf)).toEqual(['ABCD', 'EFGH', 'I']);
  });

  it('caps each read at the configured chunk size, splitting a multi-byte character', () => {
    const { device, results } = attachedDevice();
    device.setMaxChunkBytes(1);

    device.submit(bulkOut(1, 'ü'));
    device.submit(read(2, 64));
    device.submit(read(3, 64));

    expect(results.slice(1).map((result) => [...result.data])).toEqual([[0xc3], [0xbc]]);
  });

  it('accepts writes and returns nothing in silent mode', () => {
    const { device, results } = attachedDevice();
    device.setBehaviour('silent');

    device.submit(read(1, 64));
    device.submit(bulkOut(2, 'IGNORED'));

    expect(results.map((result) => result.seqnum)).toEqual([2]);
    expect(device.status().bytesFromHost).toBe(7);
  });

  it('sends bytes the device produces on its own', () => {
    const { device, results } = attachedDevice();

    device.submit(read(1, 64));
    device.sendToHost(encoder.encode('READY\r\n'));

    expect(textOf(results[0])).toBe('READY\r\n');
  });

  it('keeps writes in flight while hung and accepts them in their original order on resume', () => {
    const { device, results } = attachedDevice();
    device.hang();

    device.submit(bulkOut(1, 'ONE'));
    device.submit(bulkOut(2, 'TWO'));
    const whileHung = results.length;
    device.resume();
    device.submit(read(3, 64));

    expect(whileHung).toBe(0);
    expect(results.map((result) => result.seqnum)).toEqual([1, 2, 3]);
    expect(textOf(results[2])).toBe('ONETWO');
  });

  it('cancels a pending read on unlink, and the cancelled read never completes', () => {
    const { device, results } = attachedDevice();

    device.submit(read(1, 64));
    const status = device.unlink({ kind: 'unlink', seqnum: 2, unlinkSeqnum: 1 });
    device.submit(bulkOut(3, 'X'));
    device.submit(read(4, 64));

    expect(status).toBe(-104);
    expect(results.map((result) => result.seqnum)).toEqual([3, 4]);
  });

  it('cancels a write held by a hung device, which is then not delivered on resume', () => {
    const { device, results } = attachedDevice();
    device.hang();

    device.submit(bulkOut(1, 'LOST'));
    const status = device.unlink({ kind: 'unlink', seqnum: 2, unlinkSeqnum: 1 });
    device.resume();

    expect(status).toBe(-104);
    expect(results).toEqual([]);
    expect(device.status().bytesFromHost).toBe(0);
  });

  it('reports nothing to cancel for a transfer that already completed', () => {
    const { device } = attachedDevice();

    device.submit(bulkOut(1, 'DONE'));

    expect(device.unlink({ kind: 'unlink', seqnum: 2, unlinkSeqnum: 1 })).toBe(0);
  });

  it('holds interrupt reads, since the device has no notification to send', () => {
    const { device, results } = attachedDevice();

    device.submit(read(1, 16, 1));

    expect(results).toEqual([]);
    expect(device.unlink({ kind: 'unlink', seqnum: 2, unlinkSeqnum: 1 })).toBe(-104);
  });

  it('stalls a transfer to an endpoint the device does not have', () => {
    const { device, results } = attachedDevice();

    device.submit(read(1, 64, 5));

    expect(results[0]?.status).toBe(-32);
  });
});

describe('CdcAcmDevice detach', () => {
  it('drops transfers in flight and bytes not yet read, as unplugging would', () => {
    const { device, results } = attachedDevice();
    device.submit(control(1, 0x00, 0x09, 1, 0));
    device.submit(bulkOut(2, 'STALE'));
    device.submit(read(3, 16, 1));

    device.detach();
    const afterReattach: UrbResult[] = [];
    device.attach((result) => afterReattach.push(result));
    device.submit(read(4, 64));

    expect(results.map((result) => result.seqnum)).toEqual([1, 2]);
    expect(afterReattach).toEqual([]);
    expect(device.status()).toMatchObject({ configurationValue: 0, bytesQueuedToHost: 0 });
  });

  it('completes nothing while detached', () => {
    const device = new CdcAcmDevice(IDENTITY);
    const results: UrbResult[] = [];
    device.attach((result) => results.push(result));
    device.detach();

    device.submit(control(1, 0x80, 0x06, 0x0100, 18));

    expect(results).toEqual([]);
    expect(device.status().isAttached).toBe(false);
  });
});
