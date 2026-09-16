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
import { normalizeConfiguration } from '../../src/core/validation.js';
import { openDiagnostics } from '../../src/diagnostics.js';
import type { DiagnosticsSnapshot, SerialBrokerDiagnostics } from '../../src/diagnostics.js';
import { createBrowserEnvironment } from '../../src/environment/browser.js';
import type { SerialBrokerEnvironment } from '../../src/environment/environment.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { ConfigurationStore } from '../../src/storage/configuration-store.js';

import { ChooseMessage } from './choose-message.js';
import { formValuesForChosenDevice } from './chosen-port.js';
import { ConfigurationDetail, type DetailHost } from './detail.js';
import { byId, element } from './dom.js';
import { EventLog } from './event-log.js';
import {
  describeError,
  describeOwnershipLocks,
  formatDevice,
  plural,
  shortClientId,
} from './format.js';
import {
  LIBRARY_SETTINGS_KEY,
  linkedWorkerUrlToConfirm,
  linkWithSettings,
  resolveLibrarySettings,
  type LibrarySettings,
} from './library-settings.js';
import { ConfigurationList } from './list.js';
import { buildConfigurationViews, type RememberedConfiguration } from './model.js';
import { isFramedByAnotherOrigin, SETUP_ACTION_IDS } from './page-guard.js';
import { SetupDialog } from './setup-dialog.js';

/** How often every tab is asked for a report. */
const REFRESH_INTERVAL_MS = 2_000;
/** How long each collection listens for answers; same-origin messages take well under 10 ms. */
const COLLECT_WINDOW_MS = 300;
const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

const query = new URLSearchParams(location.search);
const savedSettings = readStorage(LIBRARY_SETTINGS_KEY);
const defaultWorkerUrl = new URL('../serial-broker.worker.js', import.meta.url).href;
const linkedWorkerUrl = linkedWorkerUrlToConfirm(query, savedSettings, defaultWorkerUrl);
if (
  linkedWorkerUrl !== undefined &&
  // Synchronous on purpose: nothing starts before the operator has answered. A browser that
  // suppresses the dialog, as Chromium does in a frame of another origin, answers no.
  !window.confirm(
    `This link sets the worker script to\n\n${linkedWorkerUrl}\n\nThe page runs that script with the rights of this site. Use it only if you trust whoever sent the link. Use this worker?`,
  )
) {
  query.delete('workerUrl');
}
const settings = resolveLibrarySettings(query, savedSettings, defaultWorkerUrl);
const isFramedElsewhere = isFramedByAnotherOrigin(window);

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
const logLevelSelect = byId('logLevel') as HTMLSelectElement;
// Read from the list rather than assumed: a browser that restores the form on reload can bring
// back a level other than the one marked as selected.
let logLevel: LogLevel = LOG_LEVELS.find((level) => level === logLevelSelect.value) ?? 'info';
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

if (isFramedElsewhere) {
  // A page of another origin could lay its own content over the buttons that send to devices and
  // forget them. The page starts nothing there, so nothing can be clicked into acting.
  const banner = byId('banner');
  banner.textContent =
    'serial-broker does not start inside a page of another origin. Open this page on its own.';
  banner.hidden = false;
  hideSetupActions();
} else {
  try {
    environment = createBrowserEnvironment({
      workerUrl: settings.workerUrl,
      transport: settings.transport,
      logger: pageLogger,
      logPayloads: settings.logPayloads,
    });
    client = new SerialBrokerClient(environment);
    // With the page's logger, so what the observer drops or fails at shows up in the page's log.
    diagnostics = openDiagnostics({
      workerUrl: settings.workerUrl,
      transport: settings.transport,
      logger: pageLogger,
    });
  } catch (error) {
    const banner = byId('banner');
    // Not always the browser: a transport forced under Settings that this browser lacks fails too.
    banner.textContent = `serial-broker could not start on this page: ${describeError(error).text}`;
    banner.hidden = false;
    hideSetupActions();
  }
}

/** Hides everything that would set a configuration up, where this page cannot run one. */
function hideSetupActions(): void {
  for (const id of SETUP_ACTION_IDS) {
    byId(id).hidden = true;
  }
}

/**
 * The notice under the header, about the last click on _Choose a device…_.
 *
 * Every action the page offers takes it down first (see {@link ChooseMessage}), so a dismissed
 * picker cannot go on claiming that nothing was set up while the operator connects, disconnects or
 * creates a configuration.
 */
const chooseMessage = new ChooseMessage(byId('chooseMessage'));

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
/**
 * Configurations the setup dialog is replacing right now. Between disconnecting and connecting
 * again one may be set up nowhere, and its detail view - with its traffic - is kept meanwhile.
 */
const replacing = new Set<string>();
/** What the settings panel's facts showed last, so an unchanged panel is not rebuilt. */
let factsShown = '';

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
  disconnect(name, options) {
    act(name, `disconnect from "${name}"`, async () => {
      await requireClient().release(name, options);
    });
  },
  chooseDevice(name, chooseAgain) {
    chooseMessage.clear();
    const detail = details.get(name)?.detail;
    let pending: Promise<boolean>;
    try {
      pending = requireClient().requestAccess(name, { chooseAgain });
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
  try {
    if (request.replaces !== undefined && page.exists(request.replaces)) {
      // The library judges the new settings before anything is released: a rejected value must
      // leave the running configuration, and the copy remembered for it, as they were.
      normalizeConfiguration(request.name, request.options);
      // Settings only change by connecting again: this page disconnects, and connects with the new
      // ones. Other tabs keep theirs.
      replacing.add(request.replaces);
      await page.release(request.replaces);
    }
    await page.setup(request.name, request.options);
  } catch (error) {
    // Also logged, because the dialog may have been closed before the answer arrived.
    logFailure(`set up "${request.name}"`, error);
    throw error;
  } finally {
    if (request.replaces !== undefined) {
      replacing.delete(request.replaces);
    }
  }
  selectedName = request.name;
  if (request.requestsAccess) {
    await chooseDeviceFor(request.name);
  }
  refreshNow();
});

/**
 * Opens the browser's port picker for a configuration just set up in auto mode, in the click that
 * set it up (ADR-0036).
 *
 * The configuration takes its device from the port chosen, and the library remembers it. A
 * dismissed picker is an answer, not a failure: the configuration is released again, so nothing
 * waits for a device nobody chose, and nothing is remembered.
 */
async function chooseDeviceFor(name: string): Promise<void> {
  const page = requireClient();
  let granted: boolean;
  try {
    granted = await page.requestAccess(name);
  } catch (error) {
    logFailure(`choose a device for "${name}"`, error);
    await page.release(name);
    throw error;
  }
  if (!granted) {
    await page.release(name);
    chooseMessage.show('The picker was dismissed; nothing was set up.');
  }
}
for (const id of ['newButton', 'emptyNewButton']) {
  byId(id).addEventListener('click', () => {
    chooseMessage.clear();
    dialog.open();
  });
}
for (const id of ['chooseButton', 'emptyChooseButton']) {
  byId(id).addEventListener('click', chooseADevice);
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
  const chosen = readSettingsForm();
  const isSaved = writeStorage(LIBRARY_SETTINGS_KEY, JSON.stringify(chosen));
  // Query parameters would override what was just saved, so the reload drops them. Where saving
  // failed, the address is the one place the settings survive the reload in.
  location.replace(isSaved ? location.pathname : linkWithSettings(location.href, chosen));
});
// A note about a copied link would otherwise describe settings that have changed since.
for (const id of ['workerUrl', 'transport', 'logPayloads']) {
  byId(id).addEventListener('input', () => {
    byId('linkNote').textContent = '';
  });
}

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

logLevelSelect.addEventListener('change', () => {
  logLevel = logLevelSelect.value as LogLevel;
});
byId('clearLog').addEventListener('click', () => {
  pageLog.clear();
});
byId('log')
  .closest('details')
  ?.addEventListener('toggle', () => {
    pageLog.revealed();
  });

window.addEventListener('pagehide', (event) => {
  // A page kept in the back/forward cache comes back with the same script state, and a closed
  // observer cannot be reopened: it would collect nothing and watch nothing from then on.
  if (!event.persisted) {
    diagnostics?.close();
  }
});

// --- Choosing a device ------------------------------------------------------------------------

/**
 * Offers a configuration in auto mode: a name and the line settings, and the browser's port
 * picker on _Connect_.
 *
 * This is where someone who has not used serial-broker before starts: no vendor ID, no product
 * ID, no device type - confirm the settings, choose the port, and the page is connected to it
 * (ADR-0034, ADR-0036). The picker is opened by `requestAccess()` in the click that submits the
 * dialog, because the browser shows it only for a fresh user gesture.
 */
function chooseADevice(): void {
  chooseMessage.clear();
  try {
    // Reported before anything is asked: a page that cannot run a configuration must not ask for
    // a device permission it would then have no use for.
    requireClient();
  } catch (error) {
    chooseMessage.show(describeError(error).text, 'error');
    return;
  }
  dialog.chooseDevice(formValuesForChosenDevice(knownNames()));
}

/** Every configuration name this origin knows, so a suggested name is not one of them. */
function knownNames(): string[] {
  return buildConfigurationViews({
    thisTab: client?.diagnostics(),
    snapshot,
    remembered: remembered(),
  }).map((view) => view.name);
}

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
  Promise.resolve()
    .then(async () => {
      render();
      await refresh();
    })
    .catch((error: unknown) => {
      logFailure('refresh the page', error);
    });
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

/**
 * Shows everything, and leaves the other tabs' reports out if they cannot be shown.
 *
 * A report from another tab is checked only as far as filing it needs (ADR-0018, amended): one from a
 * build that reports differently, or from a script of the origin, can lack a field the page reads.
 * It costs the view of the other tabs until the next collection, never the page.
 */
function render(): void {
  try {
    renderPage();
  } catch (error) {
    logFailure('show the reports of the other tabs', error);
    snapshot = undefined;
    renderPage();
  }
}

function renderPage(): void {
  const now = Date.now();
  const views = buildConfigurationViews({
    thisTab: client?.diagnostics(),
    snapshot,
    remembered: remembered(),
  });

  const isReplacing = (name: string | undefined): boolean =>
    name !== undefined && replacing.has(name);
  if (!views.some((view) => view.name === selectedName) && !isReplacing(selectedName)) {
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
    if (!shown.has(name) && !isReplacing(name)) {
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

  const hasAny = views.length > 0 || replacing.size > 0;
  byId('overview').hidden = !hasAny;
  byId('empty').hidden = hasAny || client === undefined;
  // Port locks and granted ports change while the panel is open.
  if (!byId('settingsPanel').hidden) {
    void renderFacts();
  }

  const tabCount = snapshot?.participants.length;
  byId('busStatus').textContent =
    diagnostics === undefined || tabCount === undefined
      ? ''
      : // "Answered" rather than "connected", which on this page means connected to a configuration.
        `${plural(tabCount, 'tab')} answered over ${transportName(diagnostics.transport)}.`;
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
  // The notice about the last click on "Choose a device…" describes an action that is over.
  chooseMessage.clear();
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
  'This page': 'help-this-page',
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
      'This page',
      client === undefined
        ? '—'
        : `${shortClientId(client.clientId)}, ${client.transportKind === undefined ? 'joins the bus with its first configuration' : transportName(client.transportKind)}`,
    ],
    ['Protocol version', String(PROTOCOL_VERSION)],
    ['Port locks', describeOwnershipLocks(snapshot?.locks, PROTOCOL_VERSION)],
    ['Granted ports', await describePorts()],
  ];
  // Rebuilt only when something changed: the panel is redrawn every two seconds, and replacing its
  // "?" buttons each time would take keyboard focus away from them.
  const shown = JSON.stringify(
    facts.map(([term, value]) => [term, typeof value === 'string' ? value : value.textContent]),
  );
  if (shown === factsShown) {
    return;
  }
  factsShown = shown;
  byId('facts').replaceChildren(
    ...facts.flatMap(([term, value]) => [
      element('dt', {}, [term, ...helpFor(term)]),
      typeof value === 'string' ? element('dd', { text: value }) : element('dd', {}, [value]),
    ]),
  );
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

/** @returns Whether the value was saved. */
function writeStorage(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (error) {
    logFailure('save the settings', error);
    return false;
  }
}
