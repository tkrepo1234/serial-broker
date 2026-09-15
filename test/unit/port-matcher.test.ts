import { describe, expect, it } from 'vitest';

import { ScopedLogger } from '../../src/core/logger.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import type { SerialLike, SerialPortLike } from '../../src/environment/environment.js';
import {
  describeDevice,
  findGrantedPort,
  matchesDevice,
  resolveDevice,
  toRequestOptions,
} from '../../src/owner/port-matcher.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

/**
 * Matching granted ports against a device filter, for the kinds ADR-0036 added: a port without
 * USB identity, and auto mode before and after it has resolved.
 */

const serial = { baudRate: 9600 };
const USB = { vendorId: 0x1a86, productId: 0x7523 };

function port(info: { usbVendorId?: number; usbProductId?: number }): SerialPortLike {
  return { getInfo: () => info } as unknown as SerialPortLike;
}

const usbPort = port({ usbVendorId: USB.vendorId, usbProductId: USB.productId });
const otherUsbPort = port({ usbVendorId: 0x0403, usbProductId: 0x6001 });
const bareport = port({});
const halfPort = port({ usbVendorId: USB.vendorId });

function device(filter: unknown) {
  return normalizeConfiguration('Reader', { device: filter, serial });
}

describe('matchesDevice', () => {
  it('matches every port for an any-port filter, and only the named device for USB IDs', () => {
    const any = device({ any: true });
    const usb = device(USB);

    expect(matchesDevice(bareport, any)).toBe(true);
    expect(matchesDevice(usbPort, any)).toBe(true);
    expect(matchesDevice(usbPort, usb)).toBe(true);
    expect(matchesDevice(otherUsbPort, usb)).toBe(false);
    expect(matchesDevice(bareport, usb)).toBe(false);
  });

  it('matches only ports without a USB identity for a non-USB filter', () => {
    const configuration = device({ nonUsb: true });

    expect(matchesDevice(bareport, configuration)).toBe(true);
    // Half an identity is no identity a filter could find the port by again (ADR-0034).
    expect(matchesDevice(halfPort, configuration)).toBe(true);
    expect(matchesDevice(usbPort, configuration)).toBe(false);
  });

  it('matches no port at all for an auto-mode filter that has not resolved', () => {
    // The user's choice is the resolution. A port granted for something else is not it, even when
    // it is the only one granted.
    const configuration = device({ auto: true });

    expect(matchesDevice(usbPort, configuration)).toBe(false);
    expect(matchesDevice(bareport, configuration)).toBe(false);
  });

  it('matches what an auto-mode filter has resolved to', () => {
    const usb = device({ auto: true, resolved: USB });
    const nonUsb = device({ auto: true, resolved: { nonUsb: true } });

    expect(matchesDevice(usbPort, usb)).toBe(true);
    expect(matchesDevice(otherUsbPort, usb)).toBe(false);
    expect(matchesDevice(bareport, usb)).toBe(false);
    expect(matchesDevice(bareport, nonUsb)).toBe(true);
    expect(matchesDevice(usbPort, nonUsb)).toBe(false);
  });
});

describe('resolveDevice', () => {
  it('takes both USB IDs from a port that reports them', () => {
    expect(resolveDevice(usbPort)).toEqual({ kind: 'usb', ...USB });
  });

  it('takes a port that reports no identity, or half of one, as non-USB', () => {
    expect(resolveDevice(bareport)).toEqual({ kind: 'non-usb' });
    expect(resolveDevice(halfPort)).toEqual({ kind: 'non-usb' });
    expect(resolveDevice(port({ usbProductId: 1 }))).toEqual({ kind: 'non-usb' });
  });

  it('resolves to a device the same port then matches', () => {
    for (const chosen of [usbPort, bareport, halfPort]) {
      const resolved = resolveDevice(chosen);
      const configuration = device({
        auto: true,
        resolved:
          resolved.kind === 'usb'
            ? { vendorId: resolved.vendorId, productId: resolved.productId }
            : { nonUsb: true },
      });

      expect(matchesDevice(chosen, configuration)).toBe(true);
    }
  });
});

describe('toRequestOptions', () => {
  it('opens the picker unfiltered for auto mode, so every port is offered', () => {
    expect(toRequestOptions(device(undefined))).toEqual({});
    expect(toRequestOptions(device({ auto: true }))).toEqual({});
  });

  it('filters the picker to what auto mode has resolved to, as for the explicit filter', () => {
    expect(toRequestOptions(device({ auto: true, resolved: USB }))).toEqual({
      filters: [{ usbVendorId: USB.vendorId, usbProductId: USB.productId }],
    });
    expect(toRequestOptions(device({ auto: true, resolved: { nonUsb: true } }))).toEqual({});
  });

  it('opens the picker unfiltered for a non-USB or any-port filter, which no filter could describe', () => {
    // An empty `filters` array would hide exactly the ports these exist to find.
    expect(toRequestOptions(device({ nonUsb: true }))).toEqual({});
    expect(toRequestOptions(device({ any: true }))).toEqual({});
  });
});

describe('describeDevice', () => {
  it('reports the kind in effect, and the USB IDs only for a USB one', () => {
    expect(describeDevice(device({ auto: true }).device)).toEqual({
      kind: 'auto',
      vendorId: undefined,
      productId: undefined,
    });
    expect(describeDevice(device({ auto: true, resolved: USB }).device)).toEqual({
      kind: 'usb',
      ...USB,
    });
    expect(describeDevice(device({ auto: true, resolved: { nonUsb: true } }).device)).toEqual({
      kind: 'non-usb',
      vendorId: undefined,
      productId: undefined,
    });
    expect(describeDevice(device({ any: true }).device).kind).toBe('any');
    expect(describeDevice(device({ nonUsb: true }).device).kind).toBe('non-usb');
    expect(describeDevice(device(USB).device)).toEqual({ kind: 'usb', ...USB });
  });
});

describe('findGrantedPort', () => {
  function granted(...ports: SerialPortLike[]): SerialLike {
    return { getPorts: async () => ports } as unknown as SerialLike;
  }

  it('waits for the user in auto mode even when exactly one port is granted', async () => {
    // The safer default of ADR-0036: the one granted port may belong to another configuration, and
    // auto mode promises the device the user chose, not the device that happened to be there.
    const { logger, records } = recordingLogger();

    const found = await findGrantedPort(
      granted(usbPort),
      device({ auto: true }),
      new ScopedLogger(logger, {}),
    );

    expect(found).toBeUndefined();
    expect(fieldsOfEvent(records, 'matcher.none')).toEqual([
      expect.objectContaining({ grantedPorts: 1, filter: 'auto' }),
    ]);
  });

  it('finds the port an auto-mode configuration resolved to among the granted ones', async () => {
    const found = await findGrantedPort(
      granted(otherUsbPort, bareport, usbPort),
      device({ auto: true, resolved: USB }),
      new ScopedLogger(recordingLogger().logger, {}),
    );

    expect(found).toBe(usbPort);
  });

  it('warns with the resolved kind when several granted ports match', async () => {
    const { logger, records } = recordingLogger();

    const found = await findGrantedPort(
      granted(bareport, halfPort),
      device({ auto: true, resolved: { nonUsb: true } }),
      new ScopedLogger(logger, {}),
    );

    expect(found).toBe(bareport);
    expect(fieldsOfEvent(records, 'matcher.ambiguous')).toEqual([
      expect.objectContaining({ matchCount: 2, filter: 'non-usb' }),
    ]);
  });
});
