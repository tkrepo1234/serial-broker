/**
 * The debugging surface: every configuration on this origin, as one card each, with what can be
 * done about it right on the card.
 *
 * It ships in the package as static content under `dist/debug/`. Nothing serves it unless an
 * operator does. See debug/README.md and ADR-0019.
 *
 * Cards are built from two sources: this tab's own client, which acts the way an application
 * does, and the diagnostics observer, which sees every other tab without taking part in
 * ownership (ADR-0018). The page never sets anything up on its own - opening it to look must not
 * move a port.
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

import { ConfigurationCard, type CardHost } from './card.js';
import { byId, element } from './dom.js';
import { EventLog } from './event-log.js';
import { formatUsbId, shortClientId } from './format.js';
import {
  LIBRARY_SETTINGS_KEY,
  linkWithSettings,
  resolveLibrarySettings,
  type LibrarySettings,
} from './library-settings.js';
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
  banner.textContent = `serial-broker cannot run in this browser: ${describeError(error)}`;
  banner.hidden = false;
  byId('newButton').hidden = true;
}

// --- Cards ----------------------------------------------------------------------------------

const cardTemplate = byId('cardTemplate') as HTMLTemplateElement;
const cards = new Map<string, { card: ConfigurationCard; stopWatching: Unsubscribe | undefined }>();
let snapshot: DiagnosticsSnapshot | undefined;

const host: CardHost = {
  join(name, joined) {
    act(name, `set up "${name}"`, async () => {
      await requireClient().setup(name, joined);
    });
  },
  release(name, forgetDevice) {
    act(name, `release "${name}"`, async () => {
      await requireClient().release(name, { forgetDevice });
    });
  },
  chooseDevice(name) {
    const card = cards.get(name)?.card;
    let pending: Promise<boolean>;
    try {
      pending = requireClient().requestAccess(name);
    } catch (error) {
      card?.showError(error);
      return;
    }
    void pending.then(
      (granted) => {
        if (!granted) {
          card?.showNotice('The picker was dismissed; nothing changed.');
        }
        refreshNow();
      },
      (error: unknown) => {
        card?.showError(error);
        logFailure(`choose a device for "${name}"`, error);
      },
    );
  },
  send(name, data) {
    act(name, `send to "${name}"`, async () => {
      await requireClient().send(name, data);
    });
  },
};

const dialog = new SetupDialog(byId('setupDialog') as HTMLDialogElement, async (name, options) => {
  await requireClient().setup(name, options);
  refreshNow();
});
byId('newButton').addEventListener('click', () => {
  dialog.open();
});
byId('emptyNewButton').addEventListener('click', () => {
  dialog.open();
});

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
  await refresh();
  setTimeout(() => {
    void refreshLoop();
  }, REFRESH_INTERVAL_MS);
}

/** Redraws from this tab's fresh state at once, then again when the other tabs have answered. */
function refreshNow(): void {
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

  const container = byId('cards');
  const shown = new Set<string>();
  views.forEach((view, index) => {
    shown.add(view.name);
    let entry = cards.get(view.name);
    if (entry === undefined) {
      const card = new ConfigurationCard(view.name, cardTemplate, host);
      entry = { card, stopWatching: watch(card) };
      cards.set(view.name, entry);
    }
    entry.card.update(view, now);
    if (container.children[index] !== entry.card.element) {
      container.insertBefore(entry.card.element, container.children[index] ?? null);
    }
  });
  for (const [name, entry] of cards) {
    if (!shown.has(name)) {
      entry.stopWatching?.();
      entry.card.element.remove();
      cards.delete(name);
    }
  }

  byId('empty').hidden = views.length > 0 || client === undefined;

  const tabCount = snapshot?.participants.length;
  byId('busStatus').textContent =
    diagnostics === undefined || tabCount === undefined
      ? ''
      : `${String(tabCount)} tab${tabCount === 1 ? '' : 's'} connected over ${transportName(diagnostics.transport)}.`;
}

function transportName(transport: 'sharedworker' | 'broadcastchannel'): string {
  return transport === 'sharedworker' ? 'SharedWorker' : 'BroadcastChannel';
}

/** Streams a configuration's traffic from every tab into its card. */
function watch(card: ConfigurationCard): Unsubscribe | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  try {
    return diagnostics.watch(card.name, (event) => {
      card.addEvent(event, client?.clientId);
    });
  } catch (error) {
    logFailure(`watch "${card.name}"`, error);
    return undefined;
  }
}

/** Runs a card's action, and shows a failure on that card. */
function act(name: string, action: string, work: () => Promise<void>): void {
  void work().then(refreshNow, (error: unknown) => {
    cards.get(name)?.card.showError(error);
    logFailure(action, error);
    render();
  });
}

function remembered(): RememberedConfiguration[] {
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

async function renderFacts(): Promise<void> {
  const check = (label: string, isPresent: boolean): string => `${isPresent ? '✓' : '✗'} ${label}`;
  const facts: [string, string][] = [
    [
      'Browser',
      [
        check('secure context', window.isSecureContext),
        check('Web Serial', 'serial' in navigator),
        check('Web Locks', 'locks' in navigator),
        check('SharedWorker', typeof SharedWorker !== 'undefined'),
        check('BroadcastChannel', typeof BroadcastChannel !== 'undefined'),
      ].join('   '),
    ],
    [
      'This tab',
      client === undefined
        ? '—'
        : `${shortClientId(client.clientId)}, ${client.transportKind === undefined ? 'connects with its first configuration' : transportName(client.transportKind)}`,
    ],
    ['Protocol version', String(PROTOCOL_VERSION)],
    ['Port locks', describeLocks()],
    ['Granted ports', await describePorts()],
  ];
  byId('facts').replaceChildren(
    ...facts.flatMap(([term, value]) => [
      element('dt', { text: term }),
      element('dd', { text: value }),
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
          : `${formatUsbId(info.usbVendorId)}:${formatUsbId(info.usbProductId).slice(2)}`;
      })
      .join(', ');
  } catch (error) {
    return describeError(error);
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
    `Could not ${action}: ${describeError(error)}`,
    error instanceof SerialBrokerError ? error.toJSON() : undefined,
  );
}

function describeError(error: unknown): string {
  if (error instanceof SerialBrokerError) {
    return `${error.code} - ${error.remediation}`;
  }
  return error instanceof Error ? error.message : String(error);
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
