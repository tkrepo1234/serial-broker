/**
 * The debugging surface: every configuration on this origin in one list, and the selected one in
 * detail, with what can be done about it from this page.
 *
 * It ships in the package as static content under `dist/debug/`. Nothing serves it unless an
 * operator does. See debug/README.md and ADR-0019.
 *
 * What it shows comes from two sources: this page's own client, which acts the way an application
 * does, and the diagnostics observer, which sees every other tab without taking part in ownership
 * (ADR-0018). The page never sets anything up on its own - opening it to look must not move a port.
 */

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { describeSettings } from '../../src/core/diagnostics.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import type { Logger, LogLevel, TransportKind, Unsubscribe } from '../../src/core/types.js';
import { openDiagnostics } from '../../src/diagnostics.js';
import type { DiagnosticsSnapshot, SerialBrokerDiagnostics } from '../../src/diagnostics.js';
import { createBrowserEnvironment } from '../../src/environment/browser.js';
import type { SerialBrokerEnvironment } from '../../src/environment/environment.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { ConfigurationStore } from '../../src/storage/configuration-store.js';

import { ConfigurationDetail, type DetailHost } from './detail.js';
import { byId, element } from './dom.js';
import { EventLog } from './event-log.js';
import { describeError, formatDevice, shortClientId } from './format.js';
import {
  LIBRARY_SETTINGS_KEY,
  linkWithSettings,
  resolveLibrarySettings,
  type LibrarySettings,
} from './library-settings.js';
import { ConfigurationList } from './list.js';
import { buildConfigurationViews, type RememberedConfiguration } from './model.js';
import { SetupDialog } from './setup-dialog.js';

/** How often every tab is asked for a report. */
const REFRESH_INTERVAL_MS = 2_000;
/** How long each collection listens for answers; same-origin messages take well under 10 ms. */
const COLLECT_WINDOW_MS = 300;
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const settings = resolveLibrarySettings(
  new URLSearchParams(location.search),
  readStorage(LIBRARY_SETTINGS_KEY),
  new URL('../serial-broker.worker.js', import.meta.url).href,
);

// Every help text closes the same way, so its Close button is added here rather than written out
// once per help text in the page.
for (const help of document.querySelectorAll<HTMLElement>('.help-text[popover]')) {
  const close = element('button', {
    className: 'secondary small',
    text: 'Close',
    attributes: { type: 'button', popovertarget: help.id, popovertargetaction: 'hide' },
  });
  help.append(element('div', { className: 'actions' }, [close]));
}

const pageLog = new EventLog(byId('log'), 1_000);
let logLevel: LogLevel = 'info';
const pageLogger: Logger = {
  log(level, message, fields) {
    if (LOG_LEVELS.indexOf(level) >= LOG_LEVELS.indexOf(logLevel)) {
      pageLog.add(`log-${level}`, level, message, fields);
    }
  },
};

let environment: SerialBrokerEnvironment | undefined;
let client: SerialBrokerClient | undefined;
let diagnostics: SerialBrokerDiagnostics | undefined;

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
  const banner = byId('banner');
  banner.textContent = `serial-broker cannot run in this browser: ${describeError(error).text}`;
  banner.hidden = false;
  byId('newButton').hidden = true;
}

// --- Configurations ---------------------------------------------------------------------------

const detailTemplate = byId('detailTemplate') as HTMLTemplateElement;
const details = new Map<
  string,
  { detail: ConfigurationDetail; stopWatching: Unsubscribe | undefined }
>();
let snapshot: DiagnosticsSnapshot | undefined;
/** The configuration shown in detail. The first one in the list when nothing was chosen. */
let selectedName: string | undefined;
/**
 * The configurations remembered in this browser, read when they may have changed rather than on
 * every refresh: reading reports an invalid entry each time, which would flood the log.
 */
let rememberedCache: RememberedConfiguration[] | undefined;
window.addEventListener('storage', () => {
  rememberedCache = undefined;
});

const list = new ConfigurationList(byId('configurationRows'), (name) => {
  selectedName = name;
  render();
});

const host: DetailHost = {
  connect(name, connectWith) {
    act(name, `connect to "${name}"`, async () => {
      await requireClient().setup(name, connectWith);
    });
  },
  disconnect(name, forgetDevice) {
    act(name, `disconnect from "${name}"`, async () => {
      await requireClient().release(name, { forgetDevice });
    });
  },
  chooseDevice(name) {
    const detail = details.get(name)?.detail;
    let pending: Promise<boolean>;
    try {
      pending = requireClient().requestAccess(name);
    } catch (error) {
      detail?.showError(error);
      return;
    }
    void pending.then(
      (granted) => {
        if (!granted) {
          detail?.showNotice('The picker was dismissed; nothing changed.');
        }
        refreshNow();
      },
      (error: unknown) => {
        detail?.showError(error);
        logFailure(`choose a device for "${name}"`, error);
      },
    );
  },
  edit(name, current) {
    dialog.edit(name, current);
  },
  send(name, data) {
    act(name, `send to "${name}"`, async () => {
      await requireClient().send(name, data);
    });
  },
};

const dialog = new SetupDialog(byId('setupDialog') as HTMLDialogElement, async (request) => {
  const page = requireClient();
  if (request.replaces !== undefined && page.exists(request.replaces)) {
    // Settings only change by connecting again: this page disconnects, and connects with the new
    // ones. Other tabs keep theirs.
    await page.release(request.replaces);
  }
  await page.setup(request.name, request.options);
  selectedName = request.name;
  refreshNow();
});
for (const id of ['newButton', 'emptyNewButton']) {
  byId(id).addEventListener('click', () => {
    dialog.open();
  });
}

void refreshLoop();

// --- Settings and log -------------------------------------------------------------------------

(byId('workerUrl') as HTMLInputElement).value = settings.workerUrl;
(byId('transport') as HTMLSelectElement).value = settings.transport;
(byId('logPayloads') as HTMLInputElement).checked = settings.logPayloads;

const settingsToggle = byId('settingsToggle');
settingsToggle.addEventListener('click', () => {
  const panel = byId('settingsPanel');
  panel.hidden = !panel.hidden;
  settingsToggle.setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) {
    void renderFacts();
  }
});

byId('applySettings').addEventListener('click', () => {
  writeStorage(LIBRARY_SETTINGS_KEY, JSON.stringify(readSettingsForm()));
  // Query parameters would override what was just saved, so the reload drops them.
  location.replace(location.pathname);
});

byId('copyLink').addEventListener('click', () => {
  const link = linkWithSettings(location.href, readSettingsForm());
  const note = byId('linkNote');
  navigator.clipboard.writeText(link).then(
    () => {
      note.textContent = 'Link copied.';
    },
    () => {
      note.textContent = link;
    },
  );
});

(byId('logLevel') as HTMLSelectElement).addEventListener('change', (event) => {
  logLevel = (event.target as HTMLSelectElement).value as LogLevel;
});
byId('clearLog').addEventListener('click', () => {
  pageLog.clear();
});

window.addEventListener('pagehide', () => {
  diagnostics?.close();
});

// --- Helpers ----------------------------------------------------------------------------------

async function refreshLoop(): Promise<void> {
  try {
    await refresh();
  } catch (error) {
    // One failed redraw must not stop the page from ever refreshing again.
    logFailure('refresh the page', error);
  } finally {
    setTimeout(() => {
      void refreshLoop();
    }, REFRESH_INTERVAL_MS);
  }
}

/** Redraws from this page's fresh state at once, then again when the other tabs have answered. */
function refreshNow(): void {
  // An action may have set something up or released it, which changes what is remembered.
  rememberedCache = undefined;
  render();
  void refresh();
}

async function refresh(): Promise<void> {
  if (diagnostics !== undefined) {
    try {
      snapshot = await diagnostics.collect(COLLECT_WINDOW_MS);
    } catch (error) {
      logFailure('ask the other tabs', error);
    }
  }
  render();
}

function render(): void {
  const now = Date.now();
  const views = buildConfigurationViews({
    thisTab: client?.diagnostics(),
    snapshot,
    remembered: remembered(),
  });

  if (!views.some((view) => view.name === selectedName)) {
    selectedName = views[0]?.name;
  }

  list.update(views, selectedName);

  const shown = new Set(views.map((view) => view.name));
  for (const view of views) {
    let entry = details.get(view.name);
    if (entry === undefined) {
      const detail = new ConfigurationDetail(view.name, detailTemplate, host);
      entry = { detail, stopWatching: watch(detail) };
      details.set(view.name, entry);
    }
    entry.detail.update(view, now);
  }
  for (const [name, entry] of details) {
    if (!shown.has(name)) {
      entry.stopWatching?.();
      entry.detail.element.remove();
      details.delete(name);
    }
  }

  const container = byId('detail');
  const selected = selectedName === undefined ? undefined : details.get(selectedName)?.detail;
  if (selected === undefined) {
    container.replaceChildren();
  } else if (container.firstElementChild !== selected.element) {
    container.replaceChildren(selected.element);
  }

  byId('overview').hidden = views.length === 0;
  byId('empty').hidden = views.length > 0 || client === undefined;
  // Port locks and granted ports change while the panel is open.
  if (!byId('settingsPanel').hidden) {
    void renderFacts();
  }

  const tabCount = snapshot?.participants.length;
  byId('busStatus').textContent =
    diagnostics === undefined || tabCount === undefined
      ? ''
      : `${String(tabCount)} tab${tabCount === 1 ? '' : 's'} connected over ${transportName(diagnostics.transport)}.`;
}

function transportName(transport: 'sharedworker' | 'broadcastchannel'): string {
  return transport === 'sharedworker' ? 'SharedWorker' : 'BroadcastChannel';
}

/** Streams a configuration's traffic from every tab into its detail view. */
function watch(detail: ConfigurationDetail): Unsubscribe | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  try {
    return diagnostics.watch(detail.name, (event) => {
      detail.addEvent(event, client?.clientId);
    });
  } catch (error) {
    logFailure(`watch "${detail.name}"`, error);
    return undefined;
  }
}

/** Runs an action on a configuration, and shows a failure in its detail view. */
function act(name: string, action: string, work: () => Promise<void>): void {
  void work().then(refreshNow, (error: unknown) => {
    details.get(name)?.detail.showError(error);
    logFailure(action, error);
    render();
  });
}

function remembered(): RememberedConfiguration[] {
  rememberedCache ??= readRemembered();
  return rememberedCache;
}

function readRemembered(): RememberedConfiguration[] {
  if (environment === undefined) {
    return [];
  }
  const store = new ConfigurationStore(environment.storage, environment.logger, (error) => {
    logFailure('read remembered configurations', error);
  });
  return store.load().map((configuration) => ({
    name: configuration.name,
    settings: describeSettings(configuration),
  }));
}

/**
 * One thing the browser has or lacks, as a status dot and its name.
 *
 * @param whenMissing - The dot for a missing capability: `failed` when serial-broker cannot work
 *   without it, `connecting` (the warning colour) when something else can stand in.
 */
function capability(
  label: string,
  isPresent: boolean,
  whenMissing: 'failed' | 'connecting' = 'failed',
): HTMLLIElement {
  return element('li', { title: `${label}: ${isPresent ? 'available' : 'not available'}` }, [
    element('span', { className: `dot ${isPresent ? 'open' : whenMissing}` }),
    isPresent ? label : `${label} (not available)`,
  ]);
}

/** The explanation each fact in the settings panel opens. */
const FACT_HELP: Readonly<Record<string, string>> = {
  Browser: 'help-browser',
  'Message bus': 'help-bus',
  'This tab': 'help-this-tab',
  'Protocol version': 'help-protocol',
  'Port locks': 'help-locks',
  'Granted ports': 'help-ports',
};

/** A "?" that opens the explanation of a fact, where it has one. */
function helpFor(term: string): HTMLButtonElement[] {
  const popoverId = FACT_HELP[term];
  return popoverId === undefined
    ? []
    : [
        element('button', {
          className: 'help',
          text: '?',
          attributes: { type: 'button', popovertarget: popoverId, 'aria-label': `About ${term}` },
        }),
      ];
}

async function renderFacts(): Promise<void> {
  const hasSharedWorker = typeof SharedWorker !== 'undefined';
  const hasBroadcastChannel = typeof BroadcastChannel !== 'undefined';
  // Either bus will do, so one that is missing is only a warning while the other exists.
  const missingBus = hasSharedWorker || hasBroadcastChannel ? 'connecting' : 'failed';

  const facts: [string, string | Node][] = [
    [
      'Browser',
      element('ul', { className: 'capabilities' }, [
        capability('secure context', window.isSecureContext),
        capability('Web Serial', 'serial' in navigator),
        capability('Web Locks', 'locks' in navigator),
      ]),
    ],
    [
      'Message bus',
      element('ul', { className: 'capabilities' }, [
        capability('SharedWorker', hasSharedWorker, missingBus),
        capability('BroadcastChannel', hasBroadcastChannel, missingBus),
      ]),
    ],
    [
      'This tab',
      client === undefined
        ? '—'
        : `${shortClientId(client.clientId)}, ${client.transportKind === undefined ? 'joins the bus with its first configuration' : transportName(client.transportKind)}`,
    ],
    ['Protocol version', String(PROTOCOL_VERSION)],
    ['Port locks', describeLocks()],
    ['Granted ports', await describePorts()],
  ];
  byId('facts').replaceChildren(
    ...facts.flatMap(([term, value]) => [
      element('dt', {}, [term, ...helpFor(term)]),
      typeof value === 'string' ? element('dd', { text: value }) : element('dd', {}, [value]),
    ]),
  );
}

function describeLocks(): string {
  const locks = snapshot?.locks;
  if (locks === undefined) {
    return 'not listed by this browser';
  }
  const names = [...new Set([...locks.held, ...locks.pending].map((lock) => lock.name))];
  if (names.length === 0) {
    return 'none';
  }
  return names
    .map((name) => {
      const waiting = locks.pending.filter((lock) => lock.name === name).length;
      const isHeld = locks.held.some((lock) => lock.name === name);
      return `${name.split('/').pop() ?? name}: ${isHeld ? 'held' : 'free'}${waiting > 0 ? `, ${String(waiting)} waiting` : ''}`;
    })
    .join(' · ');
}

async function describePorts(): Promise<string> {
  if (!('serial' in navigator)) {
    return '—';
  }
  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length === 0) {
      return 'none yet';
    }
    return ports
      .map((port) => {
        const info = port.getInfo();
        return info.usbVendorId === undefined
          ? 'no USB identity'
          : formatDevice(info.usbVendorId, info.usbProductId);
      })
      .join(', ');
  } catch (error) {
    return describeError(error).text;
  }
}

function readSettingsForm(): LibrarySettings {
  return {
    workerUrl: (byId('workerUrl') as HTMLInputElement).value.trim(),
    transport: (byId('transport') as HTMLSelectElement).value as TransportKind,
    logPayloads: (byId('logPayloads') as HTMLInputElement).checked,
  };
}

function requireClient(): SerialBrokerClient {
  if (client === undefined) {
    throw new Error('serial-broker could not start in this browser.');
  }
  return client;
}

function logFailure(action: string, error: unknown): void {
  pageLog.add(
    'error',
    'error',
    `Could not ${action}: ${describeError(error).text}`,
    error instanceof SerialBrokerError ? error.toJSON() : undefined,
  );
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
    logFailure('save the settings', error);
  }
}
