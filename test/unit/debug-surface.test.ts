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
import { buildConfigurationViews } from '../../debug/src/model.js';
import {
  buildSetupOptions,
  defaultFormValues,
  deviceChoiceFor,
} from '../../debug/src/setup-form.js';
import type {
  ConfigurationDiagnostics,
  DiagnosticsSnapshot,
  ParticipantDiagnostics,
} from '../../src/core/diagnostics.js';
import { describeSettings } from '../../src/core/diagnostics.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { normalizeConfiguration } from '../../src/core/validation.js';

import { sampleReport } from './fixtures/diagnostics-report.js';

/** A tab reporting the sample configuration, with some of its fields replaced. */
function tab(
  clientId: string,
  overrides: Partial<ConfigurationDiagnostics> = {},
): ParticipantDiagnostics {
  const report = sampleReport();
  return { ...report, clientId, configurations: [{ ...report.configurations[0]!, ...overrides }] };
}

function snapshotOf(...participants: ParticipantDiagnostics[]): DiagnosticsSnapshot {
  return { collectedAt: 0, observerClientId: 'd-1', participants, locks: undefined };
}

/**
 * The debugging surface's logic, away from the DOM.
 *
 * Its promise is that every card offers exactly what can be done from here, and that what it
 * sends is what was typed. Both are easy to break quietly, so they are pinned here.
 */
describe('debugging surface: cards', () => {
  it('offers to join a configuration only another tab runs, using that tab settings', () => {
    const [view] = buildConfigurationViews({
      thisTab: undefined,
      snapshot: snapshotOf(tab('c-2')),
      remembered: [],
    });

    expect(view?.owner?.clientId).toBe('c-2');
    expect(view?.isSetUpHere).toBe(false);
    expect([...(view?.actions ?? [])]).toEqual(['join']);
    expect(view?.settings).toEqual(sampleReport().configurations[0]?.settings);
  });

  it('offers the device picker only to the tab that holds the port and has no device yet', () => {
    const owning = buildConfigurationViews({
      thisTab: tab('c-1', { status: 'awaiting-permission' }),
      snapshot: undefined,
      remembered: [],
    });
    const waiting = buildConfigurationViews({
      thisTab: tab('c-1', {
        role: 'participant',
        status: 'awaiting-permission',
        connection: undefined,
      }),
      snapshot: snapshotOf(tab('c-2', { status: 'awaiting-permission' })),
      remembered: [],
    });

    expect([...(owning[0]?.actions ?? [])].sort()).toEqual(['choose-device', 'release']);
    expect([...(waiting[0]?.actions ?? [])]).toEqual(['release']);
  });

  it("uses this tab's own fresh report over its entry in an older collection, and lists it first", () => {
    const [view] = buildConfigurationViews({
      thisTab: tab('c-9', { role: 'participant', status: 'open', connection: undefined }),
      snapshot: snapshotOf(
        tab('c-1'),
        tab('c-9', { role: 'participant', status: 'reconnecting', connection: undefined }),
      ),
      remembered: [],
    });

    expect(view?.tabs.map((entry) => [entry.clientId, entry.configuration.status])).toEqual([
      ['c-9', 'open'],
      ['c-1', 'open'],
    ]);
    expect(view?.tabs[0]?.isThisTab).toBe(true);
  });

  it('shows a remembered configuration nobody runs, ready to start', () => {
    const settings = sampleReport().configurations[0]!.settings;

    const [view] = buildConfigurationViews({
      thisTab: undefined,
      snapshot: snapshotOf(),
      remembered: [{ name: 'Scale', settings }],
    });

    expect(view).toMatchObject({ name: 'Scale', status: undefined, isRemembered: true, settings });
    expect(view?.tabs).toEqual([]);
    expect([...(view?.actions ?? [])]).toEqual(['join']);
  });

  it('flags tabs that run the same configuration with different settings', () => {
    const settings = sampleReport().configurations[0]!.settings;

    const [view] = buildConfigurationViews({
      thisTab: undefined,
      snapshot: snapshotOf(
        tab('c-1'),
        tab('c-2', {
          role: 'participant',
          connection: undefined,
          settings: { ...settings, connection: { ...settings.connection, maxDelayMs: 1_000 } },
        }),
      ),
      remembered: [],
    });

    expect(view?.settingsDiffer).toBe(true);
  });

  it('can join with reported settings as they are, because setup accepts them unchanged', () => {
    const running = normalizeConfiguration('Scale', {
      device: { vendorId: 0x0403, productId: 0x6001 },
      serial: { baudRate: 19_200, parity: 'odd', stopBits: 2 },
      connection: { maxDelayMs: 1_000 },
      encoding: { decodeText: false },
      persist: false,
    });

    expect(normalizeConfiguration('Scale', describeSettings(running))).toEqual(running);
  });
});

describe('debugging surface: new configuration', () => {
  it('leaves blank optional fields out, so the library applies its own defaults', () => {
    expect(buildSetupOptions(defaultFormValues())).toEqual({
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

  it('recognises a preset from its IDs, and anything else as another device', () => {
    const values = defaultFormValues();

    expect(deviceChoiceFor(values)).toBe('0');
    expect(deviceChoiceFor({ ...values, vendorId: '0x1209', productId: '0x0001' })).toBe('3');
    expect(deviceChoiceFor({ ...values, vendorId: '0xdead' })).toBe('custom');
    expect(deviceChoiceFor({ ...values, deviceKind: 'any' })).toBe('any');
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
    // Each separated group holds whole bytes; single digits are a typing mistake, not glued.
    expect(() => parseHexBytes('0x1 0x2')).toThrow(/not a sequence of hex bytes/);
    expect(() => parseHexBytes('1 2 3 4')).toThrow(/not a sequence of hex bytes/);
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
