import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { ChooseMessage } from '../../debug/src/choose-message.js';
import {
  chooseDeviceOrUndo,
  formValuesForChosenDevice,
  suggestDeviceName,
  type DeviceChooser,
} from '../../debug/src/chosen-port.js';
import {
  describeError,
  describeOwnershipLocks,
  describePayload,
  formatBytes,
  formatDetail,
  formatDevice,
  formatRelative,
  formatUsbId,
  formatValue,
  parseHexBytes,
  plural,
  shortClientId,
  statusLabel,
  summarizeSettings,
  tabLabel,
  toHex,
} from '../../debug/src/format.js';
import {
  linkedWorkerUrlToConfirm,
  linkWithSettings,
  resolveLibrarySettings,
} from '../../debug/src/library-settings.js';
import {
  buildConfigurationViews,
  isWithdrawn,
  tabRole,
  thisPageState,
} from '../../debug/src/model.js';
import { isFramedByAnotherOrigin, SETUP_ACTION_IDS } from '../../debug/src/page-guard.js';
import {
  buildSetupOptions,
  defaultFormValues,
  defaultPlaceholders,
  deviceChoiceFor,
  formValuesFor,
  rejectedField,
} from '../../debug/src/setup-form.js';
import {
  DEFAULT_CONNECTION_SETTINGS,
  DEFAULT_ENCODING_SETTINGS,
  DEFAULT_MAX_TABS,
  DEFAULT_SERIAL_SETTINGS,
} from '../../src/core/defaults.js';
import type {
  ConfigurationDiagnostics,
  DiagnosticsSnapshot,
  ParticipantDiagnostics,
} from '../../src/core/diagnostics.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { toSetupOptions } from '../../src/core/validation.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import { matchesDevice } from '../../src/owner/port-matcher.js';
import { ownerLockName, PROTOCOL_VERSION, tabSlotLockName } from '../../src/protocol/version.js';

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

/** The page's markup, as the tests below read it: the source, not a rendered document. */
async function debugPage(): Promise<string> {
  return await readFile('debug/public/index.html', 'utf8');
}

/**
 * The debugging surface's logic, away from the DOM.
 *
 * Its promise is that every card offers exactly what can be done from here, and that what it
 * sends is what was typed. Both are easy to break quietly, so they are pinned here.
 */
describe('debugging surface: configurations', () => {
  it('offers to connect to a configuration only another tab runs, with that tab settings', () => {
    const [view] = buildConfigurationViews({
      thisTab: undefined,
      snapshot: snapshotOf(tab('c-2')),
      remembered: [],
    });

    expect(view?.owner?.clientId).toBe('c-2');
    expect(view?.isSetUpHere).toBe(false);
    // Connecting is what this page can do with it, and editing and disconnecting are offered for
    // every configuration it shows: disconnecting is where forgetting is asked for, which is about
    // what the browser keeps rather than about this page.
    expect([...(view?.actions ?? [])].sort()).toEqual(['connect', 'disconnect', 'edit']);
    expect(view?.settings).toEqual(sampleReport().configurations[0]?.settings);
  });

  it('offers the device picker to every tab using a configuration that has no device yet', () => {
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

    expect([...(owning[0]?.actions ?? [])].sort()).toEqual(['choose-device', 'disconnect', 'edit']);
    // The permission is the origin's: a tab that does not hold the port may ask as well (ADR-0022).
    expect([...(waiting[0]?.actions ?? [])].sort()).toEqual([
      'choose-device',
      'disconnect',
      'edit',
    ]);
  });

  it('offers a tab that withdrew over its tab limit no device picker', () => {
    const settings = sampleReport().configurations[0]!.settings;
    const [view] = buildConfigurationViews({
      thisTab: tab('c-1', {
        role: 'participant',
        status: 'failed',
        lastErrorCode: SerialBrokerErrorCode.CONFIGURATION_CONFLICT,
        connection: undefined,
        settings: { ...settings, maxTabs: 2 },
      }),
      snapshot: snapshotOf(tab('c-2', { status: 'awaiting-permission' })),
      remembered: [],
    });

    expect([...(view?.actions ?? [])].sort()).toEqual(['disconnect', 'edit']);
  });

  it('offers a tab queued for a place to disconnect and edit, never the device picker', () => {
    const [view] = buildConfigurationViews({
      thisTab: tab('c-1', { role: 'participant', status: 'queued', connection: undefined }),
      snapshot: snapshotOf(tab('c-2', { status: 'awaiting-permission' })),
      remembered: [],
    });

    expect([...(view?.actions ?? [])].sort()).toEqual(['disconnect', 'edit']);
    expect(view?.tabs[0]?.configuration.status).toBe('queued');
  });

  it('offers to choose a different device to every tab of an auto-mode configuration that has one', () => {
    const settings = sampleReport().configurations[0]!.settings;
    const withDevice = (device: typeof settings.device): Partial<ConfigurationDiagnostics> => ({
      settings: { ...settings, device },
    });
    const resolved = withDevice({ auto: true, resolved: { vendorId: 0x1a86, productId: 0x7523 } });
    const viewsOf = (overrides: Partial<ConfigurationDiagnostics>, role: 'owner' | 'participant') =>
      buildConfigurationViews({
        thisTab: tab('c-1', { ...overrides, role, status: 'open' }),
        snapshot: snapshotOf(tab('c-2', { ...overrides, status: 'open' })),
        remembered: [],
      })[0]?.actions ?? new Set();

    expect(viewsOf(resolved, 'owner').has('choose-again')).toBe(true);
    expect(viewsOf(resolved, 'participant').has('choose-again')).toBe(true);
    expect(viewsOf(withDevice({ auto: true }), 'owner').has('choose-again')).toBe(false);
    expect(viewsOf({}, 'owner').has('choose-again')).toBe(false);
    const queued = buildConfigurationViews({
      thisTab: tab('c-1', { ...resolved, role: 'participant', status: 'queued' }),
      snapshot: snapshotOf(tab('c-2', resolved)),
      remembered: [],
    });
    expect(queued[0]?.actions.has('choose-again')).toBe(false);
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

  it('shows a remembered configuration nobody runs, ready to connect to', () => {
    const settings = sampleReport().configurations[0]!.settings;

    const [view] = buildConfigurationViews({
      thisTab: undefined,
      snapshot: snapshotOf(),
      remembered: [{ name: 'Scale', settings }],
    });

    expect(view).toMatchObject({ name: 'Scale', status: undefined, isRemembered: true, settings });
    expect(view?.tabs).toEqual([]);
    // Nobody runs it, and it can still be edited and dropped: an entry the browser remembers must
    // not have to be connected to before it can be forgotten.
    expect([...(view?.actions ?? [])].sort()).toEqual(['connect', 'disconnect', 'edit']);
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

  it('tells a tab that withdrew over its tab limit from one that follows a holder that failed', () => {
    const settings = sampleReport().configurations[0]!.settings;
    const conflict = SerialBrokerErrorCode.CONFIGURATION_CONFLICT;
    const participant = { role: 'participant', connection: undefined } as const;

    const [view] = buildConfigurationViews({
      thisTab: tab('c-1', {
        ...participant,
        status: 'failed',
        lastErrorCode: conflict,
        settings: { ...settings, maxTabs: 2 },
      }),
      snapshot: snapshotOf(
        tab('c-2', { status: 'failed' }),
        // Carries the conflict's code and follows the holder into `failed`, but runs the holder's
        // limit: nothing to withdraw over.
        tab('c-3', { ...participant, status: 'failed', lastErrorCode: conflict }),
        tab('c-4', { ...participant, status: 'queued' }),
      ),
      remembered: [],
    });

    expect(view?.tabs.map((entry) => [entry.clientId, tabRole(entry, view.owner)])).toEqual([
      ['c-1', 'withdrew'],
      ['c-2', 'holds the port'],
      ['c-3', 'waiting'],
      ['c-4', 'queued'],
    ]);
    expect(thisPageState(view!)).toBe('withdrawn');
    expect(isWithdrawn(view!.tabs[2]!, view!.owner)).toBe(false);
  });

  it("names this page's part in a configuration", () => {
    const connected = buildConfigurationViews({
      thisTab: tab('c-1'),
      snapshot: undefined,
      remembered: [],
    });
    const queued = buildConfigurationViews({
      thisTab: tab('c-1', { role: 'participant', status: 'queued', connection: undefined }),
      snapshot: snapshotOf(tab('c-2')),
      remembered: [],
    });
    const elsewhere = buildConfigurationViews({
      thisTab: undefined,
      snapshot: snapshotOf(tab('c-2')),
      remembered: [],
    });

    expect(thisPageState(connected[0]!)).toBe('connected');
    expect(thisPageState(queued[0]!)).toBe('queued');
    expect(thisPageState(elsewhere[0]!)).toBe('not connected');
  });
});

describe('debugging surface: new and edited configurations', () => {
  it.each([
    [
      'the settings a configuration runs with',
      '1',
      {
        device: { vendorId: 0x0403, productId: 0x6001 },
        serial: { baudRate: 19_200, parity: 'odd', stopBits: 2, flowControl: 'hardware' },
        connection: { maxDelayMs: 1_000 },
        encoding: { decodeText: false, encoding: 'windows-1252' },
        remember: false,
      },
    ],
    [
      'a port without USB identity',
      'any',
      { device: { any: true }, serial: { baudRate: 115_200 } },
    ],
    [
      'a port without USB identity named as such',
      'non-usb',
      { device: { nonUsb: true }, serial: { baudRate: 115_200 } },
    ],
  ])('fills the form for %s, so saving changes nothing', (_label, choice, options) => {
    const running = normalizeConfiguration('Scale', options);

    const values = formValuesFor('Scale', toSetupOptions(running));

    expect(deviceChoiceFor(values)).toBe(choice);
    expect(normalizeConfiguration('Scale', buildSetupOptions(values))).toEqual(running);
  });

  it.each([3, Number.POSITIVE_INFINITY])(
    'fills the form with a tab limit of %s, so saving changes nothing',
    (maxTabs) => {
      const running = normalizeConfiguration('Scale', {
        device: { vendorId: 0x0403, productId: 0x6001 },
        serial: { baudRate: 19_200 },
        maxTabs,
      });

      const values = formValuesFor('Scale', toSetupOptions(running));

      expect(values.maxTabs).toBe(String(maxTabs));
      expect(buildSetupOptions(values)['maxTabs']).toBe(maxTabs);
      expect(normalizeConfiguration('Scale', buildSetupOptions(values))).toEqual(running);
    },
  );

  it('leaves blank optional fields out, so the library applies its own defaults', () => {
    expect(buildSetupOptions(defaultFormValues())).toEqual({
      // Auto mode by default: the device comes from the port the user chooses (ADR-0022).
      device: { auto: true },
      serial: { baudRate: 9600 },
      // A checkbox cannot be left blank, so it starts at the library's default.
      connection: { autoReconnect: true },
      receive: {},
      encoding: { decodeText: DEFAULT_ENCODING_SETTINGS.decodeText },
      remember: true,
    });
    expect(buildSetupOptions({ ...defaultFormValues(), maxTabs: '  ' })).not.toHaveProperty(
      'maxTabs',
    );
  });

  it("offers the library's own defaults as placeholders for every field that may be left blank", () => {
    const placeholders = defaultPlaceholders();

    expect(placeholders).toMatchObject({
      bufferSize: String(DEFAULT_SERIAL_SETTINGS.bufferSize),
      'connection.maxAttempts': 'Infinity',
      'connection.writeTimeoutMs': String(DEFAULT_CONNECTION_SETTINGS.writeTimeoutMs),
      encoding: DEFAULT_ENCODING_SETTINGS.encoding,
      maxTabs: 'Infinity',
    });
    expect(placeholders['maxTabs']).toBe(String(DEFAULT_MAX_TABS));
    // Blank fields are left out of the options, so each placeholder is what the library applies.
    const running = normalizeConfiguration('Device', buildSetupOptions(defaultFormValues()));
    expect(String(running.connection.maxWriteChunkBytes)).toBe(
      placeholders['connection.maxWriteChunkBytes'],
    );
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
      encoding: { encoding: 'windows-1252', decodeText: false },
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

  it('finds the form field a rejection from the library names, so the dialog can show it', () => {
    const rejection = (name: string, changes: Partial<ReturnType<typeof defaultFormValues>>) => {
      try {
        normalizeConfiguration(name, buildSetupOptions({ ...defaultFormValues(), ...changes }));
      } catch (error) {
        return rejectedField(error);
      }
      throw new Error('The library accepted the values');
    };
    const values = defaultFormValues();

    expect(rejection('Device', { baudRate: 'fast' })).toBe('baudRate');
    expect(rejection('Device', { dataBits: '9' })).toBe('dataBits');
    expect(rejection('Device', { deviceKind: 'usb', vendorId: 'zz' })).toBe('vendorId');
    expect(rejection('Device', { maxTabs: '0' })).toBe('maxTabs');
    expect(rejection('Device', { encoding: 'no-such-encoding' })).toBe('encoding');
    expect(rejection('Device', { connection: { ...values.connection, jitter: 'lots' } })).toBe(
      'connection.jitter',
    );
    expect(rejection('', {})).toBe('name');
    expect(rejectedField(new Error('boom'))).toBeUndefined();
  });

  it('recognises a preset from its IDs, and anything else as another device', () => {
    const values = { ...defaultFormValues(), deviceKind: 'usb' as const };

    expect(deviceChoiceFor(defaultFormValues())).toBe('auto');
    expect(deviceChoiceFor(values)).toBe('0');
    expect(deviceChoiceFor({ ...values, vendorId: '0x1209', productId: '0x0001' })).toBe('3');
    expect(deviceChoiceFor({ ...values, vendorId: '0xdead' })).toBe('custom');
    expect(deviceChoiceFor({ ...values, deviceKind: 'any' })).toBe('any');
    expect(deviceChoiceFor({ ...values, deviceKind: 'non-usb' })).toBe('non-usb');
  });

  it('keeps what an automatic device resolved to, so editing the line settings does not ask again', () => {
    // Editing is release and setup: without the resolution in the options, the configuration would
    // wait for the user to choose the device once more (ADR-0022).
    for (const resolved of [{ vendorId: 0x1a86, productId: 0x7523 }, { nonUsb: true }] as const) {
      const running = normalizeConfiguration('Device', {
        device: { auto: true, resolved },
        serial: { baudRate: 9600 },
      });

      const values = formValuesFor('Device', toSetupOptions(running));

      expect(deviceChoiceFor(values)).toBe('auto');
      expect(normalizeConfiguration('Device', buildSetupOptions(values))).toEqual(running);
    }
    // The IDs it resolved to are shown, as the device list would show a named one.
    expect(
      formValuesFor(
        'Device',
        toSetupOptions(
          normalizeConfiguration('Device', {
            device: { auto: true, resolved: { vendorId: 0x1a86, productId: 0x7523 } },
            serial: { baudRate: 9600 },
          }),
        ),
      ),
    ).toMatchObject({
      deviceKind: 'auto',
      resolved: 'usb',
      vendorId: '0x1a86',
      productId: '0x7523',
    });
  });

  it('fills the form for an automatic device that has not resolved', () => {
    const waiting = normalizeConfiguration('Device', { serial: { baudRate: 9600 } });

    const values = formValuesFor('Device', toSetupOptions(waiting));

    expect(values).toMatchObject({ deviceKind: 'auto', resolved: '', vendorId: '', productId: '' });
    expect(normalizeConfiguration('Device', buildSetupOptions(values))).toEqual(waiting);
  });
});

describe('debugging surface: a device chosen in the picker', () => {
  it('sets up a configuration in auto mode, so the library takes the device from the picker', () => {
    const values = formValuesForChosenDevice([]);
    const configuration = normalizeConfiguration(values.name, buildSetupOptions(values));

    expect(values.name).toBe('Device');
    expect(values.baudRate).toBe('9600');
    expect(deviceChoiceFor(values)).toBe('auto');
    expect(buildSetupOptions(values)['device']).toEqual({ auto: true });
    // Nothing is chosen yet: the configuration waits for the picker, whatever is granted.
    expect(configuration.device).toEqual({ kind: 'auto', resolved: undefined });
    expect(
      matchesDevice(
        { getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }) } as unknown as SerialPort,
        configuration,
      ),
    ).toBe(false);
    expect(configuration.serial).toEqual({ ...DEFAULT_SERIAL_SETTINGS, baudRate: 9600 });
  });

  it('suggests a name no configuration on this origin uses yet', () => {
    expect(suggestDeviceName([])).toBe('Device');
    expect(suggestDeviceName(['Device'])).toBe('Device 2');
    expect(suggestDeviceName(['Device', 'Device 2'])).toBe('Device 3');
    expect(formValuesForChosenDevice(['Device']).name).toBe('Device 2');
  });

  /** A client that answers the picker as told, and records what was released and how. */
  function chooserAnswering(answer: boolean | Error): DeviceChooser & { released: unknown[][] } {
    const released: unknown[][] = [];
    return {
      released,
      requestAccess: () =>
        answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
      release: (name, options) => {
        released.push([name, options]);
        return Promise.resolve();
      },
    };
  }

  it('keeps the configuration when a port was chosen', async () => {
    const page = chooserAnswering(true);

    expect(await chooseDeviceOrUndo(page, 'Device')).toBe(true);
    expect(page.released).toEqual([]);
  });

  it('takes the configuration back, remembered entry included, when the picker is dismissed', async () => {
    const page = chooserAnswering(false);

    // setup() remembered the configuration at once, and a plain release keeps what is remembered
    // (ADR-0020): without `forget` the name stays in the list, and the next try is "Device 2".
    expect(await chooseDeviceOrUndo(page, 'Device')).toBe(false);
    expect(page.released).toEqual([['Device', { forget: true }]]);
  });

  it('takes it back as well when the picker fails, and reports that failure', async () => {
    const failure = new Error('no user gesture');
    const page = chooserAnswering(failure);

    await expect(chooseDeviceOrUndo(page, 'Device')).rejects.toBe(failure);
    expect(page.released).toEqual([['Device', { forget: true }]]);
  });

  it('reports the failure of the picker, not that of the release after it', async () => {
    const failure = new Error('no user gesture');
    const page: DeviceChooser = {
      requestAccess: () => Promise.reject(failure),
      release: () => Promise.reject(new Error('already released')),
    };

    await expect(chooseDeviceOrUndo(page, 'Device')).rejects.toBe(failure);
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

  it.each(['{not json', '42', JSON.stringify({ transport: 'carrier-pigeon' })])(
    'ignores saved settings that are unreadable or of the wrong shape: %s',
    (saved) => {
      expect(resolveLibrarySettings(new URLSearchParams(''), saved, DEFAULT_WORKER)).toEqual({
        workerUrl: DEFAULT_WORKER,
        transport: 'auto',
        logPayloads: false,
      });
    },
  );

  it('lets an unusable value in a link fall back to the saved one, not to the default', () => {
    const saved = JSON.stringify({ workerUrl: '/saved.js', transport: 'broadcastchannel' });

    expect(
      resolveLibrarySettings(
        new URLSearchParams('transport=BroadcastChannel&workerUrl=&logPayloads=maybe'),
        saved,
        DEFAULT_WORKER,
      ),
    ).toEqual({ workerUrl: '/saved.js', transport: 'broadcastchannel', logPayloads: false });
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

  it.each([
    'https://attacker.example/evil.js',
    '//attacker.example/evil.js',
    'data:text/javascript,postMessage(1)',
    'blob:http://localhost/0b6c',
    'javascript:alert(1)',
  ])('never takes a worker script from another origin or a data: or blob: URL: %s', (workerUrl) => {
    const saved = JSON.stringify({ workerUrl: '/saved.js' });
    const query = new URLSearchParams({ workerUrl });

    expect(resolveLibrarySettings(query, saved, DEFAULT_WORKER).workerUrl).toBe('/saved.js');
    expect(linkedWorkerUrlToConfirm(query, saved, DEFAULT_WORKER)).toBeUndefined();
  });

  it('asks to confirm a worker script that only the link names', () => {
    const saved = JSON.stringify({ workerUrl: '/assets/serial-broker.worker.js' });

    expect(
      linkedWorkerUrlToConfirm(
        new URLSearchParams('workerUrl=/uploads/evil.js'),
        saved,
        DEFAULT_WORKER,
      ),
    ).toBe('/uploads/evil.js');
    expect(
      linkedWorkerUrlToConfirm(new URLSearchParams('workerUrl=/linked.js'), null, DEFAULT_WORKER),
    ).toBe('/linked.js');
  });

  it('does not ask again for the worker the page already uses, however the link spells it', () => {
    const saved = JSON.stringify({ workerUrl: '/assets/serial-broker.worker.js' });

    expect(
      linkedWorkerUrlToConfirm(
        new URLSearchParams('workerUrl=http://localhost/assets/serial-broker.worker.js'),
        saved,
        DEFAULT_WORKER,
      ),
    ).toBeUndefined();
    expect(
      linkedWorkerUrlToConfirm(
        new URLSearchParams({ workerUrl: DEFAULT_WORKER, transport: 'broadcastchannel' }),
        null,
        DEFAULT_WORKER,
      ),
    ).toBeUndefined();
    expect(
      linkedWorkerUrlToConfirm(new URLSearchParams('transport=auto'), saved, DEFAULT_WORKER),
    ).toBeUndefined();
  });
});

describe('debugging surface: framing', () => {
  const origin = { origin: 'https://app.example' };

  it('refuses a top-level page of another origin, whose location cannot be read', () => {
    const view = {
      self: {},
      top: {
        get location(): never {
          throw new Error('SecurityError: Blocked a frame from accessing a cross-origin frame');
        },
      },
      location: origin,
    };

    expect(isFramedByAnotherOrigin(view)).toBe(true);
  });

  it('allows the page on its own and inside a page of its own origin', () => {
    const self = {};

    expect(isFramedByAnotherOrigin({ self, top: self, location: origin })).toBe(false);
    expect(isFramedByAnotherOrigin({ self, top: { location: origin }, location: origin })).toBe(
      false,
    );
  });

  it('names every header control that sets a configuration up, the help beside them included', async () => {
    // A page that cannot start hides `SETUP_ACTION_IDS` (ADR-0015). A control the list misses -
    // the `?` that explains an action the page has just removed, for instance - stays behind, so
    // the markup is checked against the list rather than trusted to agree with it.
    const html = await debugPage();

    const actions = /<div class="header-actions">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const ids = [...actions.matchAll(/<button\b([^>]*)>/g)].map(
      (button) => /\bid="([^"]*)"/.exec(button[1] ?? '')?.[1],
    );

    // Settings stays: it is what explains why the page cannot start. Every other header control
    // sets a configuration up and needs an id, because nothing can hide a control without one.
    expect(ids.filter((id) => id !== 'settingsToggle')).toEqual([...SETUP_ACTION_IDS]);
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
    // Just below a boundary, the rounded value moves to the next unit instead of overflowing.
    expect(formatRelative(999.6, 0)).toBe('in 1.0 s');
    expect(formatRelative(59_960, 0)).toBe('in 1 min 0 s');
    expect(formatRelative(119_600, 0)).toBe('in 2 min 0 s');
  });

  it('names statuses in words, and a configuration no tab runs as not running', () => {
    expect(statusLabel('open')).toBe('Port open');
    expect(statusLabel('awaiting-permission')).toBe('Waiting for device');
    expect(statusLabel('queued')).toBe('Queued for a place');
    expect(statusLabel(undefined)).toBe('Not running');
    expect(statusLabel('some-future-status')).toBe('some-future-status');
  });

  it('summarizes device and line settings on one line', () => {
    const settings = toSetupOptions(
      normalizeConfiguration('Scale', {
        device: { vendorId: 0x0403, productId: 0x6001 },
        serial: { baudRate: 19_200, parity: 'even', stopBits: 2 },
      }),
    );

    expect(summarizeSettings(settings)).toBe('0x0403:6001 · 19200 8E2');
  });

  it('summarizes an automatic device by what it resolved to, or as not chosen yet', () => {
    const summary = (device: unknown): string =>
      summarizeSettings(
        toSetupOptions(normalizeConfiguration('Device', { device, serial: { baudRate: 9600 } })),
      );

    expect(summary(undefined)).toBe('not chosen yet · 9600 8N1');
    expect(summary({ auto: true, resolved: { vendorId: 0x1a86, productId: 0x7523 } })).toBe(
      '0x1a86:7523 · 9600 8N1',
    );
    expect(summary({ auto: true, resolved: { nonUsb: true } })).toBe(
      'port without USB identity · 9600 8N1',
    );
    expect(summary({ nonUsb: true })).toBe('port without USB identity · 9600 8N1');
    expect(summary({ any: true })).toBe('any port · 9600 8N1');
  });

  it('describes a failure by its code and remediation, and anything else by its message', () => {
    const error = new SerialBrokerError(SerialBrokerErrorCode.OPEN_TIMEOUT, 'Opening timed out');

    expect(describeError(error)).toEqual({
      text: `OPEN_TIMEOUT: ${error.remediation}`,
      detail: 'Opening timed out',
    });
    expect(describeError(new Error('boom'))).toEqual({ text: 'boom', detail: '' });
    expect(describeError('plain')).toEqual({ text: 'plain', detail: '' });
  });

  it('renders byte counts in the unit that fits, without overflowing one', () => {
    expect(formatBytes(1_023)).toBe('1023 B');
    expect(formatBytes(4_200)).toBe('4.1 KB');
    // Just below a megabyte, the rounded value moves to the next unit instead of "1024.0 KB".
    expect(formatBytes(1_048_575)).toBe('1.0 MB');
    expect(formatBytes(5 * 1_048_576)).toBe('5.0 MB');
  });

  it('counts with the right noun, and names this page and other tabs one way everywhere', () => {
    expect(plural(1, 'tab')).toBe('1 tab');
    expect(plural(0, 'tab')).toBe('0 tabs');
    expect(tabLabel('c-1', 'c-1')).toBe('This page');
    expect(tabLabel('c-12-3f1a9e0b-aaaa-bbbb', 'c-1')).toBe('Tab c-12-3f…-bbbb');
    expect(tabLabel('c-2', undefined)).toBe('Tab c-2');
  });

  it('lists who holds each port from the ownership locks alone, whatever the name holds', () => {
    const lock = (name: string) => ({ name, mode: 'exclusive' as const, browserClientId: 'b' });
    const otherVersionOwnerLock = ownerLockName('Scale').replace(
      `/v${String(PROTOCOL_VERSION)}/`,
      `/v${String(PROTOCOL_VERSION + 1)}/`,
    );

    expect(
      describeOwnershipLocks(
        {
          held: [
            lock(ownerLockName('Scale')),
            lock(tabSlotLockName('Scale', 2, 0)),
            lock(ownerLockName('Rack/COM 1')),
            lock(otherVersionOwnerLock),
          ],
          pending: [lock(ownerLockName('Scale')), lock(ownerLockName('Scale')), lock('other')],
        },
        PROTOCOL_VERSION,
      ),
    ).toBe(
      `Scale: held, 2 waiting · Rack/COM 1: held · Scale (protocol ${String(PROTOCOL_VERSION + 1)}): held`,
    );
    expect(
      describeOwnershipLocks({ held: [], pending: [lock(ownerLockName('A'))] }, PROTOCOL_VERSION),
    ).toBe('A: free, 1 waiting');
    expect(describeOwnershipLocks({ held: [], pending: [] }, PROTOCOL_VERSION)).toBe('none');
    expect(describeOwnershipLocks(undefined, PROTOCOL_VERSION)).toBe('not listed by this browser');
  });

  it('renders values the way an operator reads them', () => {
    expect(formatValue(Number.POSITIVE_INFINITY)).toBe('∞');
    expect(formatValue(undefined)).toBe('—');
    expect(formatValue(false)).toBe('no');
    expect(formatUsbId(0x1a86)).toBe('0x1a86');
    expect(formatUsbId(undefined)).toBe('—');
    expect(formatDevice(0x0403, 0x6001)).toBe('0x0403:6001');
    expect(formatDevice(0x0403, undefined)).toBe('0x0403:—');
    expect(shortClientId('c-12-3f1a9e0b-aaaa-bbbb')).toBe('c-12-3f…-bbbb');
    expect(formatDetail({ data: Uint8Array.of(1, 2), max: Infinity })).toBe(
      '{\n  "data": "01 02",\n  "max": "Infinity"\n}',
    );
  });
});

describe('debugging surface: stopping a configuration', () => {
  it('offers connecting, editing and disconnecting as buttons, not hidden in a menu', async () => {
    // What an operator does to a configuration is visible while it is selected, whether or not
    // this page is connected to it: dropping a remembered entry does not take connecting to it first.
    const html = await debugPage();

    const actions = /<div class="detail-actions">([\s\S]*?)<div data-part="menu"/.exec(html)?.[1];
    for (const part of ['connect', 'choose', 'edit', 'disconnect']) {
      expect(actions).toContain(`data-part="${part}"`);
    }

    // What is left in the menu is the rare case, and nothing that stops or forgets.
    const menu = /<div data-part="menu"([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    const inMenu = [...menu.matchAll(/data-part="([^"]*)"/g)].map((button) => button[1]);
    expect(inMenu).toEqual(['menuChooseAgain']);
  });

  it('asks what to forget in a dialog, with nothing ticked to begin with', async () => {
    const html = await debugPage();

    const dialog = /<dialog id="forgetDialog">([\s\S]*?)<\/dialog>/.exec(html)?.[1] ?? '';

    // Two decisions, each its own box, and `checked` on neither: the plain answer forgets nothing.
    expect(dialog).toContain('data-part="forget"');
    expect(dialog).toContain('data-part="forgetDevice"');
    expect(dialog).not.toContain('checked');
  });

  it('tells the operator that disconnecting forgets nothing on its own', async () => {
    const html = await debugPage();

    // Read as the operator reads it: the formatter wraps this markup wherever the line fills up,
    // and a sentence split across two lines is the same sentence on the screen.
    const help = /<div id="help-actions"([\s\S]*?)<\/div>\s*<div id="help-send"/
      .exec(html)?.[1]
      ?.replace(/\s+/g, ' ');

    expect(help).toContain('asks what else should go');
    expect(help).toContain('a disconnect is not a deletion');
    expect(help).toContain('Forget the configuration');
    expect(help).toContain('Forget the device');
  });
});

describe('debugging surface: the notice about choosing a device', () => {
  const target = (): { textContent: string | null; className: string; hidden: boolean } => ({
    textContent: '',
    className: '',
    hidden: true,
  });

  it('says what came of the last click, and goes away when another action starts', () => {
    const element = target();
    const message = new ChooseMessage(element);

    message.show('The picker was dismissed; nothing was set up.');
    expect(element).toEqual({
      textContent: 'The picker was dismissed; nothing was set up.',
      className: 'message notice',
      hidden: false,
    });

    // Connecting, disconnecting, sending or creating a configuration all take it down: it
    // describes an action that is over and must not go on describing the page.
    message.clear();
    expect(element).toEqual({ textContent: '', className: 'message notice', hidden: true });
  });

  it('marks a failure as one rather than as an outcome', () => {
    const element = target();

    new ChooseMessage(element).show('serial-broker could not start on this page', 'error');

    expect(element.className).toBe('message error');
    expect(element.hidden).toBe(false);
  });
});
