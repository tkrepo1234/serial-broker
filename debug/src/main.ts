/**
 * The debugging surface: every setting and every piece of status serial-broker has, on one page.
 *
 * It ships in the package as static content under `dist/debug/`. Nothing serves it unless an
 * operator does. See debug/README.md and ADR-0019.
 *
 * It works on two levels at once, deliberately side by side:
 *
 * - **This tab** uses the library the way an application does, through the client, with every
 *   option exposed. What it shows is what an application can see.
 * - **The origin** is seen through the diagnostics observer, which takes no part in ownership and
 *   shows what ADR-0011 keeps from applications (ADR-0018).
 *
 * The page never sets anything up on its own: an operator opening it to look must not move a port.
 */

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import type { LogLevel, Logger, TransportKind, Unsubscribe } from '../../src/core/types.js';
import type { EffectiveSettings, SerialBrokerDiagnostics } from '../../src/diagnostics.js';
import { openDiagnostics } from '../../src/diagnostics.js';
import { createBrowserEnvironment, isSupported } from '../../src/environment/browser.js';
import type { SerialBrokerEnvironment } from '../../src/environment/environment.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { ConfigurationStore } from '../../src/storage/configuration-store.js';

import { DiagnosticsPanel } from './diagnostics-panel.js';
import { byId, element, row } from './dom.js';
import { EventLog, type EntryKind } from './event-log.js';
import {
  describePayload,
  formatDetail,
  formatUsbId,
  formatValue,
  parseHexBytes,
  shortClientId,
} from './format.js';
import {
  LIBRARY_SETTINGS_KEY,
  linkWithSettings,
  resolveLibrarySettings,
  type LibrarySettings,
} from './library-settings.js';
import {
  buildSetupOptions,
  defaultFormValues,
  DEVICE_PRESETS,
  readSetupForm,
  valuesFromSettings,
  writeSetupForm,
} from './setup-form.js';
import { TabPanel } from './tab-panel.js';

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

// --- Library settings --------------------------------------------------------------------------

const settings = resolveLibrarySettings(
  new URLSearchParams(location.search),
  readStorage(LIBRARY_SETTINGS_KEY),
  new URL('../serial-broker.worker.js', import.meta.url).href,
);

const tabLog = new EventLog(byId('tabLog'));
const watchLog = new EventLog(byId('watchLog'));
let logLevel: LogLevel = 'info';

/** Every library log record from this tab goes into the page log, filtered by level. */
const pageLogger: Logger = {
  log(level, message, fields) {
    if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(logLevel)) {
      tabLog.add(`log-${level}`, level, message, fields);
    }
  },
};

// --- The library, as an application uses it ----------------------------------------------------

let environment: SerialBrokerEnvironment | undefined;
let client: SerialBrokerClient | undefined;
let diagnostics: SerialBrokerDiagnostics | undefined;
const subscriptions = new Map<string, Unsubscribe[]>();

try {
  environment = createBrowserEnvironment({
    workerUrl: settings.workerUrl,
    transport: settings.transport,
    logger: pageLogger,
    logPayloads: settings.logPayloads,
  });
  client = new SerialBrokerClient(environment);
  diagnostics = openDiagnostics({ workerUrl: settings.workerUrl, transport: settings.transport });
} catch (error) {
  reportFailure('start the library', error);
  byId('supportBanner').hidden = false;
}

const setupForm = byId('setupForm') as HTMLFormElement;
const tabPanel = new TabPanel(
  byId('tabRows'),
  byId('sendTarget') as HTMLSelectElement,
  requireClient,
);

renderPlatform();
renderLibrarySettings(settings);
renderPresets();
writeSetupForm(setupForm, defaultFormValues());
renderRemembered();
void renderPorts();
tabPanel.render();

// --- Setup form ---------------------------------------------------------------------------------

setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const values = readSetupForm(setupForm);
  void run(`set up "${values.name}"`, async () => {
    await requireClient().setup(values.name, buildSetupOptions(values));
    subscribeAll(values.name);
    showResult(`"${values.name}" is set up. Watch its status in "This tab".`);
  });
});

// `requestAccess` must run synchronously inside the click: any await before it spends the user
// gesture and the browser refuses to show the picker.
byId('grantButton').addEventListener('click', () => {
  const { name } = readSetupForm(setupForm);
  let pending: Promise<boolean>;
  try {
    pending = requireClient().requestAccess(name);
  } catch (error) {
    reportFailure(`request access for "${name}"`, error);
    return;
  }
  void pending.then(
    (granted) => {
      showResult(granted ? `A device is available for "${name}".` : 'The picker was dismissed.');
      afterChange();
    },
    (error: unknown) => {
      reportFailure(`request access for "${name}"`, error);
    },
  );
});

byId('releaseButton').addEventListener('click', () => {
  releaseConfiguration(readSetupForm(setupForm).name, false);
});

byId('forgetButton').addEventListener('click', () => {
  releaseConfiguration(readSetupForm(setupForm).name, true);
});

byId('resetForm').addEventListener('click', () => {
  writeSetupForm(setupForm, defaultFormValues());
});

byId('preset').addEventListener('change', (event) => {
  const preset = DEVICE_PRESETS[Number((event.target as HTMLSelectElement).value)];
  if (preset === undefined) {
    return;
  }
  const values = readSetupForm(setupForm);
  writeSetupForm(setupForm, {
    ...values,
    deviceKind: preset.vendorId === undefined ? 'any' : 'usb',
    vendorId: preset.vendorId === undefined ? '' : formatUsbId(preset.vendorId),
    productId: preset.productId === undefined ? '' : formatUsbId(preset.productId),
  });
});

// --- This tab -----------------------------------------------------------------------------------

byId('restoreButton').addEventListener('click', () => {
  void run('restore remembered configurations', async () => {
    const restored = await requireClient().restore();
    restored.forEach(subscribeAll);
    showResult(
      restored.length === 0
        ? 'Nothing to restore that is not already set up.'
        : `Restored ${restored.join(', ')}.`,
    );
  });
});

byId('releaseAllButton').addEventListener('click', () => {
  void run('release everything', async () => {
    stopAllSubscriptions();
    await requireClient().releaseAll();
    showResult('Everything in this tab is released. Other tabs are unaffected.');
  });
});

byId('disposeButton').addEventListener('click', () => {
  void run('dispose the client', async () => {
    stopAllSubscriptions();
    await requireClient().dispose();
    if (environment !== undefined) {
      client = new SerialBrokerClient(environment);
    }
    showResult('The client was disposed and replaced by a fresh one, with a new bus identity.');
  });
});

byId('sendButton').addEventListener('click', () => {
  const target = tabPanel.selectedName;
  if (target === undefined) {
    showResult('Set a configuration up first; sends go to the one selected here.');
    return;
  }
  const payload = (byId('payload') as HTMLInputElement).value;
  const mode = (byId('payloadMode') as HTMLSelectElement).value;
  const terminator = (byId('terminator') as HTMLSelectElement).value;
  void run(`send to "${target}"`, async () => {
    const data =
      mode === 'hex' ? parseHexBytes(payload) : new TextEncoder().encode(payload + terminator);
    await requireClient().send(target, data);
  });
});

byId('payload').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    byId('sendButton').click();
  }
});

wireLogFilters(byId('tabLogFilters'), tabLog);
byId('clearTabLog').addEventListener('click', () => {
  tabLog.clear();
});

(byId('logLevel') as HTMLSelectElement).addEventListener('change', (event) => {
  logLevel = (event.target as HTMLSelectElement).value as LogLevel;
});

// --- The origin ---------------------------------------------------------------------------------

const diagnosticsPanel =
  diagnostics === undefined
    ? undefined
    : new DiagnosticsPanel(
        {
          summary: byId('diagnosticsSummary'),
          configurations: byId('diagnosticsConfigurations'),
          locks: byId('diagnosticsLocks'),
          knownNames: byId('knownNames') as HTMLDataListElement,
        },
        {
          diagnostics,
          ownClientId: () => (client?.names().length === 0 ? undefined : client?.clientId),
          adoptSettings: adoptSettings,
          reportFailure,
        },
      );

const windowInput = byId('windowMs') as HTMLInputElement;
const windowMs = (): number => Math.max(0, Math.round(Number(windowInput.value) || 500));

byId('collectButton').addEventListener('click', () => {
  void diagnosticsPanel?.collect(windowMs());
});

const autoRefresh = byId('autoRefresh') as HTMLInputElement;
const refreshInterval = byId('refreshInterval') as HTMLSelectElement;
const applyAutoRefresh = (): void => {
  diagnosticsPanel?.setAutoRefresh(
    autoRefresh.checked ? Number(refreshInterval.value) : undefined,
    windowMs,
  );
};
autoRefresh.addEventListener('change', applyAutoRefresh);
refreshInterval.addEventListener('change', applyAutoRefresh);

let stopWatching: Unsubscribe | undefined;
const watchButton = byId('watchButton') as HTMLButtonElement;
watchButton.addEventListener('click', () => {
  if (stopWatching !== undefined) {
    stopWatching();
    stopWatching = undefined;
    watchButton.textContent = 'Watch';
    watchLog.add('note', 'watch', 'Stopped watching.');
    return;
  }
  const name = (byId('watchName') as HTMLInputElement).value.trim();
  try {
    stopWatching = requireDiagnostics().watch(name, (event) => {
      const origin = shortClientId(event.from);
      switch (event.kind) {
        case 'received':
          watchLog.add(
            'received',
            'received',
            `${origin}: ${describePayload(event.data, event.text)}`,
            undefined,
            event.timestamp,
          );
          return;
        case 'sent':
          watchLog.add(
            'sent',
            'sent',
            `${origin} wrote for ${shortClientId(event.originClientId)}: ${describePayload(event.data)}`,
            undefined,
            event.timestamp,
          );
          return;
        case 'status':
          watchLog.add(
            'status',
            'status',
            `${origin}: ${event.status}`,
            undefined,
            event.timestamp,
          );
          return;
        case 'error':
          watchLog.add(
            'error',
            'error',
            `${origin}: ${event.error.code} - ${event.error.message}`,
            event.error.toJSON(),
            event.timestamp,
          );
          return;
        case 'owner-claimed':
        case 'owner-released':
          watchLog.add(
            'ownership',
            event.kind === 'owner-claimed' ? 'owner' : 'released',
            `${origin} ${event.kind === 'owner-claimed' ? 'now owns the port' : 'gave the port up'}`,
            undefined,
            event.timestamp,
          );
          return;
      }
    });
    watchButton.textContent = 'Stop watching';
    watchLog.add('note', 'watch', `Watching "${name}" across every tab of this origin.`);
  } catch (error) {
    reportFailure(`watch "${name}"`, error);
  }
});
byId('clearWatchLog').addEventListener('click', () => {
  watchLog.clear();
});

// --- Library settings and platform --------------------------------------------------------------

byId('applySettings').addEventListener('click', () => {
  const next = readLibrarySettingsForm();
  writeStorage(LIBRARY_SETTINGS_KEY, JSON.stringify(next));
  // Query parameters would override what was just saved, so the reload drops them.
  location.replace(location.pathname);
});

byId('settingsLink').addEventListener('click', () => {
  const link = linkWithSettings(location.href, readLibrarySettingsForm());
  (byId('settingsLinkText') as HTMLInputElement).value = link;
});

// --- Ports and remembered configurations --------------------------------------------------------

byId('refreshPorts').addEventListener('click', () => {
  void renderPorts();
});
if ('serial' in navigator) {
  navigator.serial.addEventListener('connect', () => {
    tabLog.add('note', 'device', 'A granted device was connected.');
    void renderPorts();
  });
  navigator.serial.addEventListener('disconnect', () => {
    tabLog.add('note', 'device', 'A granted device was disconnected.');
    void renderPorts();
  });
}

setInterval(() => {
  tabPanel.render();
  renderPlatform();
}, 1_000);

window.addEventListener('pagehide', () => {
  diagnostics?.close();
});

// --- Helpers -------------------------------------------------------------------------------------

function requireClient(): SerialBrokerClient {
  if (client === undefined) {
    throw new Error('The library could not start in this browser; see the platform panel.');
  }
  return client;
}

function requireDiagnostics(): SerialBrokerDiagnostics {
  if (diagnostics === undefined) {
    throw new Error('Diagnostics could not start in this browser; see the platform panel.');
  }
  return diagnostics;
}

/** Runs an action, reporting its failure the way the library reports it. */
async function run(action: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    reportFailure(action, error);
  } finally {
    afterChange();
  }
}

function afterChange(): void {
  tabPanel.render();
  renderPlatform();
  renderRemembered();
}

function subscribeAll(name: string): void {
  if (subscriptions.has(name)) {
    return;
  }
  const current = requireClient();
  subscriptions.set(name, [
    current.subscribe(name, 'onReceive', (event) => {
      tabLog.add(
        'received',
        'received',
        `${name}: ${describePayload(event.data, event.text)}`,
        { byteLength: event.data.byteLength, text: event.text },
        event.timestamp,
      );
    }),
    current.subscribe(name, 'onSend', (event) => {
      const isLocal = event.origin === 'local';
      tabLog.add(
        isLocal ? 'sent' : 'sent-peer',
        isLocal ? 'sent' : 'sent (peer)',
        `${name}: ${describePayload(event.data)}`,
        { byteLength: event.data.byteLength, origin: event.origin },
        event.timestamp,
      );
    }),
    current.subscribe(name, 'onStatusChange', (event) => {
      tabLog.add(
        'status',
        'status',
        `${name}: ${event.previousStatus} -> ${event.status}`,
        undefined,
        event.timestamp,
      );
      tabPanel.render();
    }),
    current.subscribe(name, 'onError', (event) => {
      tabLog.add(
        'error',
        'error',
        `${name}: ${event.error.code} - ${event.error.message}`,
        event.error.toJSON(),
        event.timestamp,
      );
    }),
  ]);
}

function stopAllSubscriptions(): void {
  for (const stops of subscriptions.values()) {
    stops.forEach((stop) => {
      stop();
    });
  }
  subscriptions.clear();
}

function releaseConfiguration(name: string, forgetDevice: boolean): void {
  void run(`release "${name}"`, async () => {
    subscriptions.get(name)?.forEach((stop) => {
      stop();
    });
    subscriptions.delete(name);
    await requireClient().release(name, { forgetDevice });
    showResult(
      forgetDevice
        ? `"${name}" is released and the browser's permission for its device is revoked.`
        : `"${name}" is released in this tab. Other tabs keep using it.`,
    );
  });
}

function reportFailure(action: string, error: unknown): void {
  if (error instanceof SerialBrokerError) {
    tabLog.add(
      'error',
      'error',
      `Could not ${action}: ${error.code} - ${error.message}`,
      error.toJSON(),
    );
    showResult(`${error.code}: ${error.remediation}`, true);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  tabLog.add('error', 'error', `Could not ${action}: ${message}`);
  showResult(message, true);
}

function showResult(message: string, isFailure = false): void {
  const result = byId('actionResult');
  result.textContent = message;
  result.classList.toggle('failure', isFailure);
}

function adoptSettings(name: string, adopted: EffectiveSettings): void {
  writeSetupForm(setupForm, valuesFromSettings(name, adopted));
  showResult(`The form now holds the settings "${name}" runs with. Set it up to join.`);
  setupForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderPlatform(): void {
  const facts: [string, string][] = [
    ['Secure context', formatValue(window.isSecureContext)],
    ['Web Serial', formatValue('serial' in navigator)],
    ['Web Locks', formatValue('locks' in navigator)],
    ['SharedWorker', formatValue(typeof SharedWorker !== 'undefined')],
    ['BroadcastChannel', formatValue(typeof BroadcastChannel !== 'undefined')],
    ['isSupported()', formatValue(isSupported())],
    ['Protocol version', String(PROTOCOL_VERSION)],
    ['Transport requested', settings.transport],
    [
      'Transport in use (this tab)',
      client?.transportKind ?? 'not on the bus until the first setup',
    ],
    ['Transport in use (observer)', diagnostics?.transport ?? '—'],
    ['This tab on the bus', client?.transportKind === undefined ? '—' : client.clientId],
    ['Configurations in this tab', String(client?.names().length ?? 0)],
  ];
  byId('platform').replaceChildren(
    ...facts.flatMap(([term, value]) => [
      element('dt', { text: term }),
      element('dd', { text: value }),
    ]),
  );
}

function renderLibrarySettings(current: LibrarySettings): void {
  (byId('workerUrl') as HTMLInputElement).value = current.workerUrl;
  (byId('transport') as HTMLSelectElement).value = current.transport;
  (byId('logPayloads') as HTMLInputElement).checked = current.logPayloads;
}

function readLibrarySettingsForm(): LibrarySettings {
  return {
    workerUrl: (byId('workerUrl') as HTMLInputElement).value.trim(),
    transport: (byId('transport') as HTMLSelectElement).value as TransportKind,
    logPayloads: (byId('logPayloads') as HTMLInputElement).checked,
  };
}

function renderPresets(): void {
  byId('preset').append(
    ...DEVICE_PRESETS.map((preset, index) =>
      element('option', { text: preset.label, attributes: { value: String(index) } }),
    ),
  );
}

function renderRemembered(): void {
  const rows = byId('rememberedRows');
  if (environment === undefined) {
    rows.replaceChildren();
    return;
  }
  const store = new ConfigurationStore(environment.storage, environment.logger, (error) => {
    reportFailure('read remembered configurations', error);
  });
  const remembered = store.load();
  rows.replaceChildren(
    ...remembered.map((configuration) => {
      const button = element('button', {
        className: 'secondary small',
        text: 'Use in form',
        attributes: { type: 'button' },
      });
      button.addEventListener('click', () => {
        adoptSettings(configuration.name, {
          device:
            configuration.device.kind === 'usb'
              ? {
                  vendorId: configuration.device.vendorId,
                  productId: configuration.device.productId,
                }
              : { any: true },
          serial: configuration.serial,
          connection: configuration.connection,
          encoding: configuration.encoding,
          persist: configuration.persist,
        });
      });
      return row([
        element('strong', { text: configuration.name }),
        configuration.device.kind === 'usb'
          ? `${formatUsbId(configuration.device.vendorId)} : ${formatUsbId(configuration.device.productId)}`
          : 'any port',
        `${String(configuration.serial.baudRate)} baud`,
        requireClient().exists(configuration.name) ? 'set up here' : 'not set up here',
        button,
      ]);
    }),
  );
  if (remembered.length === 0) {
    rows.append(row([element('em', { text: 'This origin remembers no configurations.' })]));
  }
}

async function renderPorts(): Promise<void> {
  const rows = byId('portRows');
  if (!('serial' in navigator)) {
    rows.replaceChildren(row([element('em', { text: 'This browser has no Web Serial.' })]));
    return;
  }
  try {
    const ports = await navigator.serial.getPorts();
    rows.replaceChildren(
      ...ports.map((port, index) => {
        const info = port.getInfo();
        return row([
          String(index + 1),
          info.usbVendorId === undefined
            ? 'no USB identity'
            : `${formatUsbId(info.usbVendorId)} : ${formatUsbId(info.usbProductId)}`,
          port.readable === null ? 'closed in this tab' : 'open in this tab',
          formatDetail(info),
        ]);
      }),
    );
    if (ports.length === 0) {
      rows.append(row([element('em', { text: 'No port has been granted to this origin yet.' })]));
    }
  } catch (error) {
    reportFailure('list granted ports', error);
  }
}

function wireLogFilters(container: HTMLElement, log: EventLog): void {
  for (const input of container.querySelectorAll('input[type="checkbox"]')) {
    if (!(input instanceof HTMLInputElement)) {
      continue;
    }
    input.addEventListener('change', () => {
      for (const kind of (input.dataset['kinds'] ?? '').split(' ')) {
        log.setVisible(kind as EntryKind, input.checked);
      }
    });
  }
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be denied outright; the page then runs on defaults and the URL.
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    reportFailure('save the library settings', error);
  }
}

export {};
