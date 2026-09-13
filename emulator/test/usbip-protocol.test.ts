import { describe, expect, it } from 'vitest';

import { interfaceSummaries } from '../src/usb-descriptors.ts';
import {
  decodeBusId,
  decodeOperationHeader,
  decodeUrbCommand,
  encodeDeviceListReply,
  encodeImportReply,
  encodeSubmitReply,
  encodeUnlinkReply,
  urbCommandLength,
  UsbipProtocolError,
} from '../src/usbip-protocol.ts';
import type { ExportedDevice } from '../src/usbip-protocol.ts';

import { submitCommand, unlinkCommand } from './usbip-test-client.ts';

const DEVICE: ExportedDevice = {
  path: '/sys/devices/test/1-1',
  busId: '1-1',
  busNumber: 1,
  deviceNumber: 1,
  speed: 2,
  vendorId: 0x1209,
  productId: 0x0001,
  bcdDevice: 0x0100,
  deviceClass: 0x02,
  deviceSubClass: 0x02,
  deviceProtocol: 0x00,
  configurationValue: 1,
  configurationCount: 1,
  interfaces: interfaceSummaries(),
};

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('decodeOperationHeader', () => {
  it('reads the version and operation code big-endian', () => {
    expect(decodeOperationHeader(Uint8Array.of(0x01, 0x11, 0x80, 0x05, 0, 0, 0, 0))).toEqual({
      version: 0x0111,
      code: 0x8005,
    });
  });
});

describe('decodeBusId', () => {
  it('stops at the first NUL of the fixed-width field', () => {
    const field = new Uint8Array(32);
    field.set(new TextEncoder().encode('1-1'));

    expect(decodeBusId(field)).toBe('1-1');
  });
});

describe('urbCommandLength', () => {
  it('counts the transfer buffer that follows an OUT submission', () => {
    const command = submitCommand({ seqnum: 1, direction: 'out', endpoint: 2, data: [1, 2, 3] });

    expect(urbCommandLength(command)).toBe(48 + 3);
  });

  it('counts only the header for an IN submission, whose buffer length is a request', () => {
    const command = submitCommand({ seqnum: 1, direction: 'in', endpoint: 2, length: 4096 });

    expect(urbCommandLength(command)).toBe(48);
  });

  it('counts only the header for an unlink', () => {
    expect(urbCommandLength(unlinkCommand(2, 1))).toBe(48);
  });

  it('rejects an unknown command', () => {
    const command = unlinkCommand(2, 1);
    view(command).setUint32(0, 7);

    expect(() => urbCommandLength(command)).toThrow(UsbipProtocolError);
  });

  it('rejects an isochronous transfer, which the device has no endpoint for', () => {
    const command = submitCommand({ seqnum: 1, direction: 'in', endpoint: 2, length: 64 });
    view(command).setUint32(0x20, 8);

    expect(() => urbCommandLength(command)).toThrow(/Isochronous/);
  });
});

describe('decodeUrbCommand', () => {
  it('decodes a control submission, reading the setup packet little-endian', () => {
    const bytes = submitCommand({
      seqnum: 9,
      direction: 'in',
      endpoint: 0,
      length: 18,
      setup: [0x80, 0x06, 0x00, 0x01, 0x00, 0x00, 0x12, 0x00],
    });

    expect(decodeUrbCommand(bytes)).toEqual({
      kind: 'submit',
      seqnum: 9,
      direction: 'in',
      endpointNumber: 0,
      transferBufferLength: 18,
      setup: { requestType: 0x80, request: 0x06, value: 0x0100, index: 0, length: 18 },
      data: new Uint8Array(0),
    });
  });

  it('carries the data of an OUT submission', () => {
    const command = decodeUrbCommand(
      submitCommand({ seqnum: 3, direction: 'out', endpoint: 2, data: [0x48, 0x49] }),
    );

    expect(command.kind === 'submit' && [...command.data]).toEqual([0x48, 0x49]);
  });

  it('decodes an unlink with the sequence number it cancels', () => {
    expect(decodeUrbCommand(unlinkCommand(12, 11))).toEqual({
      kind: 'unlink',
      seqnum: 12,
      unlinkSeqnum: 11,
    });
  });
});

describe('encodeDeviceListReply', () => {
  it('lays out the device record and its interfaces at the offsets the specification gives', () => {
    const reply = encodeDeviceListReply([DEVICE]);
    const replyView = view(reply);

    expect(replyView.getUint16(0)).toBe(0x0111);
    expect(replyView.getUint16(2)).toBe(0x0005);
    expect(replyView.getUint32(8)).toBe(1);
    expect(decodeBusId(reply.subarray(0x10c, 0x12c))).toBe('1-1');
    expect(replyView.getUint32(0x134)).toBe(2);
    expect(replyView.getUint16(0x138)).toBe(0x1209);
    expect(replyView.getUint16(0x13a)).toBe(0x0001);
    expect(reply[0x13e]).toBe(0x02);
    expect(reply[0x143]).toBe(2);
    expect([...reply.subarray(0x144, 0x14c)]).toEqual([0x02, 0x02, 0x01, 0, 0x0a, 0, 0, 0]);
    expect(reply.length).toBe(0x14c);
  });

  it('reports zero devices with a twelve-byte reply', () => {
    const reply = encodeDeviceListReply([]);

    expect(reply.length).toBe(12);
    expect(view(reply).getUint32(8)).toBe(0);
  });
});

describe('encodeImportReply', () => {
  it('returns the 320-byte success reply, ending with the interface count', () => {
    const reply = encodeImportReply(DEVICE);

    expect(reply.length).toBe(0x140);
    expect(view(reply).getUint32(4)).toBe(0);
    expect(decodeBusId(reply.subarray(0x108, 0x128))).toBe('1-1');
    expect(view(reply).getUint16(0x134)).toBe(0x1209);
    expect(reply[0x13f]).toBe(2);
  });

  it('refuses with the bare header and status 1', () => {
    const reply = encodeImportReply(undefined);

    expect(reply.length).toBe(8);
    expect(view(reply).getUint16(2)).toBe(0x0003);
    expect(view(reply).getUint32(4)).toBe(1);
  });
});

describe('encodeSubmitReply', () => {
  it('writes a signed status, the actual length and the returned bytes after the header', () => {
    const reply = encodeSubmitReply(5, -32, 2, Uint8Array.of(0xaa, 0xbb));

    expect(view(reply).getUint32(0)).toBe(3);
    expect(view(reply).getUint32(4)).toBe(5);
    expect(view(reply).getInt32(0x14)).toBe(-32);
    expect(view(reply).getUint32(0x18)).toBe(2);
    expect([...reply.subarray(48)]).toEqual([0xaa, 0xbb]);
  });
});

describe('encodeUnlinkReply', () => {
  it('writes the unlink sequence number and a signed status', () => {
    const reply = encodeUnlinkReply(6, -104);

    expect(reply.length).toBe(48);
    expect(view(reply).getUint32(0)).toBe(4);
    expect(view(reply).getUint32(4)).toBe(6);
    expect(view(reply).getInt32(0x14)).toBe(-104);
  });
});
