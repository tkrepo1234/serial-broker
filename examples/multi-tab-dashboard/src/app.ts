/**
 * Wires the panels to the page and to the one configuration.
 *
 * Reading order for someone taking this into an application: `device.ts` (the configuration and
 * its lifecycle), `status.ts` (every status named), `permission.ts` (the one user gesture),
 * `error-strip.ts`, `traffic.ts`. `peers.ts` and `diagnostics-panel.ts` are the two panels a
 * dashboard has that a device page does not.
 */

import { type Unsubscribe } from 'serial-broker';

import {
  configureLibrary,
  DEVICE_NAME,
  DEVICE_OPTIONS,
  releaseDevice,
  setRemembered,
  setUpDevice,
  startDevice,
  WORKER_URL,
} from './device.js';
import { createDiagnosticsPanel } from './diagnostics-panel.js';
import { byId } from './dom.js';
import { createErrorStrip, watchErrors } from './error-strip.js';
import { createPanelLogger } from './log.js';
import { createPeersPanel, tabLabel } from './peers.js';
import { syncConnectButton, wireConnectButton } from './permission.js';
import { acceptsWrites, present, renderLegend, watchStatus } from './status.js';
import { createTrafficPanel } from './traffic.js';

// --- The library, configured before its first use --------------------------------------------

const logger = createPanelLogger(byId<HTMLOListElement>('library-log'));
configureLibrary(logger);

// --- The page ---------------------------------------------------------------------------------

const label = tabLabel();
byId('tab-label').textContent = label;
// Keeps the query, so that a page opened with `?stand-in` opens its second tab the same way.
byId<HTMLAnchorElement>('open-tab').href = window.location.pathname + window.location.search;
byId('device-summary').textContent =
  `Configuration "${DEVICE_NAME}": any granted port, ${String(DEVICE_OPTIONS.serial.baudRate)} baud, text decoded as UTF-8.`;

const strip = createErrorStrip({
  strip: byId('error-strip'),
  context: byId('error-context'),
  code: byId('error-code'),
  message: byId('error-message'),
  remediation: byId('error-remediation'),
  dismiss: byId<HTMLButtonElement>('error-dismiss'),
});

const statusElement = byId('status');
const statusHint = byId('status-hint');
const legendBody = byId<HTMLTableElement>('status-legend').tBodies[0] as HTMLTableSectionElement;
renderLegend(legendBody);

const connectButton = byId<HTMLButtonElement>('connect');
const connectNote = byId('connect-note');
const retryButton = byId<HTMLButtonElement>('retry');
const setUpAgainButton = byId<HTMLButtonElement>('setup-again');
const rememberCheckbox = byId<HTMLInputElement>('remember-device');
const releaseButton = byId<HTMLButtonElement>('release');
const forgetButton = byId<HTMLButtonElement>('forget-device');

const traffic = createTrafficPanel(
  {
    list: byId<HTMLOListElement>('received'),
    partial: byId('received-partial'),
    clear: byId<HTMLButtonElement>('clear-received'),
    form: byId<HTMLFormElement>('send-form'),
    input: byId<HTMLInputElement>('send-input'),
    appendNewline: byId<HTMLInputElement>('append-newline'),
    send: byId<HTMLButtonElement>('send-button'),
  },
  strip,
);

const peers = createPeersPanel(
  byId<HTMLUListElement>('peers'),
  label,
  (status) => present(status).label,
);

const diagnostics = createDiagnosticsPanel(
  {
    body: byId<HTMLTableElement>('diagnostics').tBodies[0] as HTMLTableSectionElement,
    summary: byId('diagnostics-summary'),
    refresh: byId<HTMLButtonElement>('diagnostics-refresh'),
  },
  WORKER_URL,
  logger,
);

// --- Status -----------------------------------------------------------------------------------

/** Everything on the page that depends on the status, in one place. */
function renderStatus(status: string): void {
  const presentation = present(status);
  statusElement.textContent = presentation.label;
  statusElement.dataset['status'] = status;
  statusElement.dataset['tone'] = presentation.tone;
  statusHint.textContent = presentation.hint;
  for (const row of legendBody.rows) {
    row.classList.toggle('current', row.dataset['status'] === status);
  }

  syncConnectButton(connectButton, status);
  retryButton.hidden = status !== 'failed';
  setUpAgainButton.hidden = status !== 'released';
  releaseButton.disabled = status === 'released';
  forgetButton.disabled = status === 'released';
  traffic.setSendable(acceptsWrites(status));

  peers.announce(status);
  diagnostics.scheduleRefresh();
}

/** Shown when the configuration could not be set up at all, so there is no status to render. */
function renderNotSetUp(): void {
  statusElement.textContent = 'Not set up';
  statusElement.dataset['status'] = 'none';
  statusElement.dataset['tone'] = 'problem';
  statusHint.textContent = 'The configuration could not be set up. The error strip says why.';
  connectButton.hidden = true;
  retryButton.hidden = false;
  setUpAgainButton.hidden = true;
  releaseButton.disabled = true;
  forgetButton.disabled = true;
  traffic.setSendable(false);
  peers.announce('not set up');
}

// --- Lifecycle --------------------------------------------------------------------------------

let detach: Unsubscribe = () => undefined;

/**
 * Subscribes every panel to the configuration. Run after each `setup()`: a release ends the
 * subscriptions, and a new setup starts with none.
 */
function attach(): void {
  detach();
  const stops = [
    watchStatus(DEVICE_NAME, renderStatus),
    watchErrors(DEVICE_NAME, strip),
    traffic.attach(DEVICE_NAME),
  ];
  detach = () => {
    for (const stop of stops) {
      stop();
    }
    detach = () => undefined;
  };
}

/** Runs one action of the device panel, with the buttons disabled meanwhile. */
async function run(context: string, action: () => Promise<void>): Promise<void> {
  const buttons = [retryButton, setUpAgainButton, releaseButton, forgetButton, rememberCheckbox];
  for (const button of buttons) {
    button.disabled = true;
  }
  strip.clear();
  try {
    await action();
  } catch (error) {
    strip.show(error, context);
  } finally {
    for (const button of buttons) {
      button.disabled = false;
    }
    // The buttons a status disables stay disabled; the status decides.
    if (statusElement.dataset['status'] === 'released') {
      releaseButton.disabled = true;
      forgetButton.disabled = true;
    }
  }
}

wireConnectButton(DEVICE_NAME, connectButton, strip, (text) => {
  connectNote.textContent = text;
});

retryButton.addEventListener('click', () => {
  void run('While starting over', async () => {
    // A failed configuration stays registered; starting over means releasing it first.
    await releaseDevice();
    await setUpDevice(rememberCheckbox.checked);
    attach();
  });
});

setUpAgainButton.addEventListener('click', () => {
  void run('While setting the device up', async () => {
    await setUpDevice(rememberCheckbox.checked);
    attach();
  });
});

releaseButton.addEventListener('click', () => {
  void run('While releasing', async () => {
    await releaseDevice();
    // The status event may already have said so; saying it again is harmless.
    renderStatus('released');
  });
});

forgetButton.addEventListener('click', () => {
  void run('While forgetting the device', async () => {
    await releaseDevice(true);
    renderStatus('released');
  });
});

rememberCheckbox.addEventListener('change', () => {
  const remember = rememberCheckbox.checked;
  void run('While changing whether the device is remembered', async () => {
    await setRemembered(remember);
    attach();
  });
});

window.addEventListener('pagehide', () => {
  peers.stop();
  diagnostics.close();
  // Nothing is released on purpose: the browser lets go of this tab's locks as it unloads, and
  // another tab takes the port over. Releasing here would only make that slower.
});

// --- Start ------------------------------------------------------------------------------------

void run('While setting the device up', async () => {
  try {
    const how = await startDevice(rememberCheckbox.checked);
    // A restored configuration was remembered by definition; the checkbox follows it.
    rememberCheckbox.checked = how === 'restored' || rememberCheckbox.checked;
    attach();
  } catch (error) {
    renderNotSetUp();
    throw error;
  }
});
