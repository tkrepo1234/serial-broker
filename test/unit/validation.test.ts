import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import {
  isDeviceCompatible,
  normalizeConfiguration,
  validateName,
} from '../../src/core/validation.js';

const VALID = {
  device: { vendorId: 0x1a86, productId: 0x7523 },
  serial: { baudRate: 9600 },
};

/** Extracts the argument name a validation error names, which is its most useful field. */
function argumentOf(call: () => unknown): string {
  try {
    call();
  } catch (error) {
    return String((error as SerialBrokerError).context['argumentName']);
  }
  throw new Error('expected the call to throw');
}

describe('validateName', () => {
  it('accepts an ordinary name', () => {
    expect(validateName('CardReader')).toBe('CardReader');
  });

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => validateName(value)).toThrow(SerialBrokerError);
  });

  it('rejects a name longer than the documented limit', () => {
    expect(() => validateName('x'.repeat(129))).toThrow(/at most 128/);
  });

  it('rejects control characters', () => {
    // The name ends up in a lock name, a storage key and every log record; a newline in any
    // of those is a corruption waiting to be debugged by someone else.
    expect(() => validateName(`Reader${String.fromCharCode(10)}`)).toThrow(/control characters/);
    expect(() => validateName(String.fromCharCode(0))).toThrow(/control characters/);
  });

  it('accepts non-ASCII names', () => {
    expect(validateName('Kartenleser-Süd')).toBe('Kartenleser-Süd');
  });
});

describe('normalizeConfiguration', () => {
  it('applies every documented default', () => {
    const config = normalizeConfiguration('Reader', VALID);

    expect(config.serial).toEqual({
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      bufferSize: 255,
      flowControl: 'none',
    });
    expect(config.connection.initialDelayMs).toBe(250);
    expect(config.connection.maxAttempts).toBe(Number.POSITIVE_INFINITY);
    expect(config.encoding).toEqual({ encoding: 'utf-8', decodeText: false });
    expect(config.persist).toBe(true);
  });

  it('freezes what it returns', () => {
    const config = normalizeConfiguration('Reader', VALID);

    // The configuration is handed to several components and outlives every call. A mutation
    // anywhere would silently change how the port is reopened after the next disconnect.
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.serial)).toBe(true);
  });

  it('names the offending field when a value is invalid', () => {
    expect(
      argumentOf(() => normalizeConfiguration('R', { ...VALID, serial: { baudRate: 0 } })),
    ).toBe('options.serial.baudRate');
    expect(
      argumentOf(() =>
        normalizeConfiguration('R', { ...VALID, device: { vendorId: 0x10000, productId: 1 } }),
      ),
    ).toBe('options.device.vendorId');
    expect(
      argumentOf(() => normalizeConfiguration('R', { ...VALID, connection: { jitter: 2 } })),
    ).toBe('options.connection.jitter');
  });

  it.each([
    ['a string baud rate', { ...VALID, serial: { baudRate: '9600' } }],
    ['a fractional baud rate', { ...VALID, serial: { baudRate: 9600.5 } }],
    ['NaN', { ...VALID, serial: { baudRate: Number.NaN } }],
    ['Infinity', { ...VALID, serial: { baudRate: Number.POSITIVE_INFINITY } }],
    ['an unsupported parity', { ...VALID, serial: { baudRate: 9600, parity: 'mark' } }],
    ['5 data bits', { ...VALID, serial: { baudRate: 9600, dataBits: 5 } }],
    ['a missing device', { serial: { baudRate: 9600 } }],
    ['a missing baud rate', { device: VALID.device, serial: {} }],
    ['an array instead of options', []],
    ['null options', null],
  ])('rejects %s', (_label, options) => {
    expect(() => normalizeConfiguration('Reader', options)).toThrow(SerialBrokerError);
  });

  it('never coerces a string into a number', () => {
    // Coercion here would mean a typo in an application's configuration silently opening a
    // port at the wrong baud rate, which presents as a device that returns garbage.
    expect(() =>
      normalizeConfiguration('Reader', { ...VALID, serial: { baudRate: '9600' } }),
    ).toThrow(SerialBrokerError);
  });

  it('accepts Infinity for maxAttempts, which JSON cannot represent', () => {
    const config = normalizeConfiguration('Reader', {
      ...VALID,
      connection: { maxAttempts: Number.POSITIVE_INFINITY },
    });

    expect(config.connection.maxAttempts).toBe(Number.POSITIVE_INFINITY);
  });

  it.each([
    ['options.connection.maxAttempts', { ...VALID, connection: { maxAttempts: -1 } }],
    ['options.connection.maxAttempts', { ...VALID, connection: { maxAttempts: 2.5 } }],
    ['options.maxTabs', { ...VALID, maxTabs: 0 }],
    ['options.maxTabs', { ...VALID, maxTabs: 'many' }],
  ])('says that %s also accepts Infinity when it rejects a value', (argumentName, options) => {
    // Infinity is the documented default of both; a message that leaves it out contradicts it.
    expect(() => normalizeConfiguration('Reader', options)).toThrow(
      expect.objectContaining({
        context: expect.objectContaining({
          argumentName,
          expected: expect.stringMatching(/, or Infinity$/) as unknown,
        }) as unknown,
      }),
    );
  });

  it('rejects -Infinity where Infinity means no limit', () => {
    expect(
      argumentOf(() =>
        normalizeConfiguration('R', {
          ...VALID,
          connection: { maxAttempts: Number.NEGATIVE_INFINITY },
        }),
      ),
    ).toBe('options.connection.maxAttempts');
  });

  it('rejects a device that asks for any port and names one as well', () => {
    expect(
      argumentOf(() =>
        normalizeConfiguration('R', { ...VALID, device: { any: true, vendorId: 0x1a86 } }),
      ),
    ).toBe('options.device');
    expect(
      argumentOf(() => normalizeConfiguration('R', { ...VALID, device: { any: false } })),
    ).toBe('options.device.any');
  });

  it('describes a rejected encoding label like any other invalid argument', () => {
    try {
      normalizeConfiguration('Reader', { ...VALID, encoding: { encoding: 'utf-99' } });
      expect.unreachable();
    } catch (error) {
      // docs/site/errors.md promises these fields for every INVALID_ARGUMENT.
      expect((error as SerialBrokerError).context).toEqual({
        argumentName: 'options.encoding.encoding',
        expected: 'an encoding label that TextDecoder accepts',
        actualType: 'string',
        actualValue: 'utf-99',
      });
      expect((error as SerialBrokerError).cause).toBeInstanceOf(RangeError);
    }
  });

  it('keeps the canonical name of an encoding label', () => {
    const config = normalizeConfiguration('Reader', { ...VALID, encoding: { encoding: 'Latin1' } });

    expect(config.encoding.encoding).toBe('windows-1252');
  });

  it('rejects an encoding the browser cannot provide', () => {
    // Checked here rather than at first use, where it would surface as a RangeError from
    // inside the owning tab's read loop, long after the mistake was made.
    const failure = () =>
      normalizeConfiguration('Reader', { ...VALID, encoding: { encoding: 'utf-99' } });

    expect(failure).toThrow(SerialBrokerError);
    expect(failure).toThrow(/encoding/);
  });

  it('reports the invalid-argument code for every rejection', () => {
    try {
      normalizeConfiguration('Reader', { ...VALID, serial: { baudRate: -1 } });
      expect.unreachable();
    } catch (error) {
      expect((error as SerialBrokerError).code).toBe(SerialBrokerErrorCode.INVALID_ARGUMENT);
    }
  });
});

describe('isDeviceCompatible', () => {
  const base = normalizeConfiguration('Reader', VALID);

  it('accepts configurations that would open the port identically', () => {
    const other = normalizeConfiguration('Reader', {
      ...VALID,
      // Neither of these reaches the hardware, so they cannot conflict.
      connection: { maxDelayMs: 1_000 },
      encoding: { decodeText: true },
    });

    expect(isDeviceCompatible(base, other)).toBe(true);
  });

  it.each([
    ['a different vendor', { ...VALID, device: { vendorId: 1, productId: 0x7523 } }],
    ['a different product', { ...VALID, device: { vendorId: 0x1a86, productId: 1 } }],
    ['a different baud rate', { ...VALID, serial: { baudRate: 19_200 } }],
    ['a different parity', { ...VALID, serial: { baudRate: 9600, parity: 'even' } }],
  ])('rejects %s', (_label, options) => {
    expect(isDeviceCompatible(base, normalizeConfiguration('Reader', options))).toBe(false);
  });
});
