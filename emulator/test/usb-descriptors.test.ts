import { describe, expect, it } from 'vitest';

import {
  configurationDescriptor,
  deviceDescriptor,
  interfaceSummaries,
  stringDescriptor,
} from '../src/usb-descriptors.ts';

const IDENTITY = {
  vendorId: 0x1209,
  productId: 0x0001,
  manufacturer: 'serial-broker',
  product: 'Grüße',
  serialNumber: 'TEST-1',
};

/** Splits a configuration descriptor into its nested descriptors by their bLength fields. */
function nestedDescriptors(bytes: Uint8Array): Uint8Array[] {
  const descriptors: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const length = bytes[offset] ?? 0;
    if (length === 0) {
      throw new Error(`zero-length descriptor at offset ${String(offset)}`);
    }
    descriptors.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return descriptors;
}

describe('deviceDescriptor', () => {
  it('declares the communications class and ACM subclass on the device, so Windows binds usbser.sys without an INF', () => {
    const descriptor = deviceDescriptor(IDENTITY);

    expect(descriptor.length).toBe(18);
    expect(descriptor[0]).toBe(18);
    expect([descriptor[4], descriptor[5]]).toEqual([0x02, 0x02]);
  });

  it('writes the vendor and product IDs little-endian', () => {
    const descriptor = deviceDescriptor({ ...IDENTITY, vendorId: 0x1a86, productId: 0x7523 });

    expect([...descriptor.subarray(8, 12)]).toEqual([0x86, 0x1a, 0x23, 0x75]);
  });

  it('reports USB 2.00, so the host asks for no BOS descriptor', () => {
    const descriptor = deviceDescriptor(IDENTITY);

    expect([descriptor[2], descriptor[3]]).toEqual([0x00, 0x02]);
  });
});

describe('configurationDescriptor', () => {
  it('sets wTotalLength to the exact byte length, with every nested descriptor fitting inside it', () => {
    const descriptor = configurationDescriptor();

    const totalLength = (descriptor[2] ?? 0) | ((descriptor[3] ?? 0) << 8);
    const nested = nestedDescriptors(descriptor);

    expect(totalLength).toBe(descriptor.length);
    expect(nested.reduce((sum, part) => sum + part.length, 0)).toBe(descriptor.length);
  });

  it('describes a communications interface with an interrupt IN endpoint and a data interface with a bulk pair', () => {
    const nested = nestedDescriptors(configurationDescriptor());

    const interfaces = nested
      .filter((part) => part[1] === 0x04)
      .map((part) => ({ number: part[2], endpoints: part[4], class: part[5] }));
    const endpoints = nested
      .filter((part) => part[1] === 0x05)
      .map((part) => ({ address: part[2], type: part[3] }));

    expect(interfaces).toEqual([
      { number: 0, endpoints: 1, class: 0x02 },
      { number: 1, endpoints: 2, class: 0x0a },
    ]);
    expect(endpoints).toEqual([
      { address: 0x81, type: 0x03 },
      { address: 0x02, type: 0x02 },
      { address: 0x82, type: 0x02 },
    ]);
  });

  it('agrees with the interface summaries the device list reports', () => {
    const nested = nestedDescriptors(configurationDescriptor());

    const fromDescriptor = nested
      .filter((part) => part[1] === 0x04)
      .map((part) => ({
        interfaceClass: part[5],
        interfaceSubClass: part[6],
        interfaceProtocol: part[7],
      }));

    expect(fromDescriptor).toEqual(interfaceSummaries());
  });
});

describe('stringDescriptor', () => {
  it('returns the US English language table for index 0', () => {
    expect([...(stringDescriptor(0, IDENTITY) ?? [])]).toEqual([4, 0x03, 0x09, 0x04]);
  });

  it('encodes a string as UTF-16LE with its byte length first', () => {
    const descriptor = stringDescriptor(2, IDENTITY);

    expect(descriptor?.[0]).toBe(2 + 'Grüße'.length * 2);
    expect(descriptor?.[1]).toBe(0x03);
    expect(Buffer.from(descriptor?.subarray(2) ?? []).toString('utf16le')).toBe('Grüße');
  });

  it('returns nothing for an index the device does not have', () => {
    expect(stringDescriptor(4, IDENTITY)).toBeUndefined();
    expect(stringDescriptor(0xee, IDENTITY)).toBeUndefined();
  });
});
