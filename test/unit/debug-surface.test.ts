import { describe, expect, it } from 'vitest';

import {
  describePayload,
  formatDetail,
  formatRelative,
  formatUsbId,
  formatValue,
  parseHexBytes,
  shortClientId,
  toHex,
} from '../../debug/src/format.js';
import { linkWithSettings, resolveLibrarySettings } from '../../debug/src/library-settings.js';
import {
  buildSetupOptions,
  defaultFormValues,
  valuesFromSettings,
} from '../../debug/src/setup-form.js';
import { describeSettings } from '../../src/core/diagnostics.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { normalizeConfiguration } from '../../src/core/validation.js';

/**
 * The debugging surface's logic, away from the DOM.
 *
 * Its promise is transparency: what it shows is what the library holds, and what it sends is
 * what was typed. Both are easy to break quietly in formatting code, so they are pinned here.
 */
describe('debugging surface: setup form', () => {
  it('leaves blank optional fields out, so the library applies its own defaults', () => {
    const options = buildSetupOptions(defaultFormValues());

    expect(options).toEqual({
      device: { vendorId: 0x1a86, productId: 0x7523 },
      serial: { baudRate: 9600 },
      connection: {},
      encoding: { decodeText: true },
      persist: true,
    });
  });

  it('passes every typed value through, including hex IDs and an unlimited attempt budget', () => {
    const values = defaultFormValues();

    const options = buildSetupOptions({
      ...values,
      deviceKind: 'any',
      dataBits: '7',
      parity: 'even',
      flowControl: 'hardware',
      encoding: 'windows-1252',
      connection: { ...values.connection, maxAttempts: 'Infinity', jitter: '0.25' },
    });

    expect(options).toMatchObject({
      device: { any: true },
      serial: { baudRate: 9600, dataBits: 7, parity: 'even', flowControl: 'hardware' },
      connection: { maxAttempts: Number.POSITIVE_INFINITY, jitter: 0.25 },
      encoding: { encoding: 'windows-1252', decodeText: true },
    });
  });

  it('leaves the verdict on a bad value to the library, which names the field', () => {
    const options = buildSetupOptions({ ...defaultFormValues(), baudRate: 'fast' });

    expect(() => normalizeConfiguration('Device', options)).toThrow(
      expect.objectContaining({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
        context: expect.objectContaining({ argumentName: 'options.serial.baudRate' }) as unknown,
      }),
    );
  });

  it('reproduces a running configuration exactly from its reported settings', () => {
    const running = normalizeConfiguration('Scale', {
      device: { vendorId: 0x0403, productId: 0x6001 },
      serial: { baudRate: 19_200, parity: 'odd', stopBits: 2 },
      connection: { maxDelayMs: 1_000, maxAttempts: 7 },
      encoding: { decodeText: false },
      persist: false,
    });

    const values = valuesFromSettings('Scale', describeSettings(running));
    const rebuilt = normalizeConfiguration(values.name, buildSetupOptions(values));

    expect(rebuilt).toEqual(running);
  });
});

describe('debugging surface: library settings', () => {
  const DEFAULT_WORKER = 'http://localhost/dist/serial-broker.worker.js';

  it('prefers the URL over saved settings, and saved settings over the defaults', () => {
    const saved = JSON.stringify({ workerUrl: '/saved.js', transport: 'broadcastchannel' });

    expect(resolveLibrarySettings(new URLSearchParams(''), null, DEFAULT_WORKER)).toEqual({
      workerUrl: DEFAULT_WORKER,
      transport: 'auto',
      logPayloads: false,
    });
    expect(resolveLibrarySettings(new URLSearchParams(''), saved, DEFAULT_WORKER)).toMatchObject({
      workerUrl: '/saved.js',
      transport: 'broadcastchannel',
    });
    expect(
      resolveLibrarySettings(
        new URLSearchParams('workerUrl=/linked.js&logPayloads=true'),
        saved,
        DEFAULT_WORKER,
      ),
    ).toEqual({ workerUrl: '/linked.js', transport: 'broadcastchannel', logPayloads: true });
  });

  it('ignores saved settings that are unreadable or of the wrong shape', () => {
    for (const saved of ['{not json', '42', JSON.stringify({ transport: 'carrier-pigeon' })]) {
      expect(resolveLibrarySettings(new URLSearchParams(''), saved, DEFAULT_WORKER)).toEqual({
        workerUrl: DEFAULT_WORKER,
        transport: 'auto',
        logPayloads: false,
      });
    }
  });

  it('round-trips settings through a link', () => {
    const settings = {
      workerUrl: '/a b.js',
      transport: 'sharedworker' as const,
      logPayloads: true,
    };

    const link = linkWithSettings('http://localhost/debug/?old=1', settings);

    expect(resolveLibrarySettings(new URL(link).searchParams, null, DEFAULT_WORKER)).toEqual(
      settings,
    );
  });
});

describe('debugging surface: formatting', () => {
  it('shows readable payloads as text and everything else as hex', () => {
    expect(describePayload(new TextEncoder().encode('OK\r\n'))).toBe('"OK\\r\\n"');
    expect(describePayload(Uint8Array.of(0x02, 0xff, 0x03))).toBe('02 FF 03');
    expect(describePayload(Uint8Array.of(0xc3), 'Ã')).toBe('"Ã"');
  });

  it('parses hex bytes however they are typed, and refuses what is not hex', () => {
    expect([...parseHexBytes('02 FF 03')]).toEqual([0x02, 0xff, 0x03]);
    expect([...parseHexBytes('0x02,0xff')]).toEqual([0x02, 0xff]);
    expect(toHex(parseHexBytes('a1b2'))).toBe('A1 B2');
    expect(() => parseHexBytes('0 2F')).toThrow(/not a sequence of hex bytes/);
    expect(() => parseHexBytes('ZZ')).toThrow(/not a sequence of hex bytes/);
  });

  it('says how far away a moment is, in both directions', () => {
    expect(formatRelative(1_400, 0)).toBe('in 1.4 s');
    expect(formatRelative(0, 320)).toBe('320 ms ago');
    expect(formatRelative(0, 125_000)).toBe('2 min 5 s ago');
  });

  it('renders values the way an operator reads them', () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue(false)).toBe('no');
    expect(formatUsbId(0x1a86)).toBe('0x1a86');
    expect(formatUsbId(undefined)).toBe('—');
    expect(shortClientId('c-12-3f1a9e0b-aaaa-bbbb')).toBe('c-12-3f…-bbbb');
    expect(formatDetail({ data: Uint8Array.of(1, 2), max: Infinity })).toBe(
      '{\n  "data": "01 02",\n  "max": "Infinity"\n}',
    );
  });
});
