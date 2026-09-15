/**
 * The application script, loaded by the browser as it is.
 *
 * The only "build" is the import map in index.html, which maps the bare specifier below to the
 * minified library. The JSDoc types are checked by `npm run typecheck` against the library's
 * published `.d.ts` files, so a misspelt option or event name is caught without a compile step -
 * see the README for why the example has a type check at all.
 */

import {
  isSerialBrokerError,
  isSupported,
  PROTOCOL_VERSION,
  SerialBroker,
  SerialBrokerErrorCode,
  SerialBrokerStatus,
} from 'serial-broker/min';

/** The configuration this page uses. Every tab sets up the same one; the name is what they share. */
const CONFIGURATION = 'Adapter';

/** @type {import('serial-broker/min').SerialBrokerOptions} */
const OPTIONS = {
  // Any granted port, so that the page works with whatever adapter is at hand. An application
  // names its device by USB ids instead - `{ vendorId: 0x1a86, productId: 0x7523 }` - which
  // filters the picker and keeps two granted devices apart.
  device: { any: true },
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
};

/**
 * Where the worker script is served: next to the library, under the prefix serve.mjs maps to
 * `node_modules/serial-broker/dist/`.
 *
 * The library looks for `serial-broker.worker.js` next to its own script and would find this URL
 * on its own. It is named explicitly anyway: a `SharedWorker` is identified by the URL of its
 * script, every tab has to use the same one, and a page that later moves the library elsewhere -
 * a CDN, a sub-path - has this one line to keep in step. `configure()` has to run before the
 * first `setup()`.
 */
const WORKER_URL = '/serial-broker/serial-broker.worker.js';

/** How much received text the page keeps. A page that runs all shift must not grow without bound. */
const RECEIVED_LIMIT = 64 * 1024;
/** How many entries the sent and log lists keep. */
const LIST_LIMIT = 200;

/** What the line-ending selector's values stand for. Nothing is appended by the library itself. */
const LINE_ENDINGS = /** @type {Readonly<Record<string, string>>} */ ({
  crlf: '\r\n',
  lf: '\n',
  cr: '\r',
  none: '',
});

/**
 * One sentence per status, for the user. The set of statuses may grow in a later version, so an
 * unknown one falls through to a neutral sentence rather than breaking the page.
 */
const STATUS_HINTS = /** @type {Readonly<Record<string, string>>} */ ({
  [SerialBrokerStatus.Idle]: 'Registered. Connecting starts in a moment.',
  [SerialBrokerStatus.Queued]:
    'As many tabs as the configuration allows are using the device. This tab takes over as soon as one of them lets go; nothing to do.',
  [SerialBrokerStatus.AwaitingPermission]:
    'No granted port matches the device. Choose it once; the browser remembers the choice for this origin.',
  [SerialBrokerStatus.Connecting]: 'Opening the port. A line sent now waits for the connection.',
  [SerialBrokerStatus.Open]:
    'Connected. Every tab of this origin receives what the device sends, and every tab can send.',
  [SerialBrokerStatus.Reconnecting]:
    'The connection was lost - device unplugged or powered off, or the tab holding the port closed. It comes back on its own; nothing to do.',
  [SerialBrokerStatus.Failed]:
    'Reconnecting gave up; the error says why. The connection revives by itself when the device reappears, or set it up again.',
  [SerialBrokerStatus.Released]: 'Given up in this tab only. Other tabs keep the device.',
});

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function byId(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`The page has no element with the id "${id}".`);
  }
  return element;
}

const ui = {
  unsupported: byId('unsupported'),
  unsupportedReason: byId('unsupported-reason'),
  status: byId('status'),
  statusHint: byId('status-hint'),
  connect: /** @type {HTMLButtonElement} */ (byId('connect')),
  retry: /** @type {HTMLButtonElement} */ (byId('retry')),
  release: /** @type {HTMLButtonElement} */ (byId('release')),
  error: byId('error'),
  errorTitle: byId('error-title'),
  errorCode: byId('error-code'),
  errorMessage: byId('error-message'),
  errorRemediation: byId('error-remediation'),
  errorDismiss: /** @type {HTMLButtonElement} */ (byId('error-dismiss')),
  sendForm: /** @type {HTMLFormElement} */ (byId('send-form')),
  sendInput: /** @type {HTMLInputElement} */ (byId('send-input')),
  lineEnding: /** @type {HTMLSelectElement} */ (byId('line-ending')),
  send: /** @type {HTMLButtonElement} */ (byId('send')),
  clearReceived: /** @type {HTMLButtonElement} */ (byId('clear-received')),
  received: byId('received'),
  sent: byId('sent'),
  logSection: byId('log-section'),
  log: byId('log'),
  configurationName: byId('configuration-name'),
  protocolVersion: byId('protocol-version'),
};

const decoder = new TextDecoder();

/** @param {number} timestamp */
function timeOf(timestamp) {
  return new Date(timestamp).toLocaleTimeString();
}

/**
 * Appends a line to one of the lists, dropping the oldest beyond the limit.
 *
 * @param {HTMLElement} list
 * @param {string} text
 */
function appendTo(list, text) {
  const item = document.createElement('li');
  item.textContent = text;
  list.append(item);
  while (list.childElementCount > LIST_LIMIT) {
    list.firstElementChild?.remove();
  }
  list.scrollTop = list.scrollHeight;
}

/**
 * Renders a status: the word itself, what it means, and which of the buttons applies to it.
 *
 * The connect button appears for `awaiting-permission` and for nothing else: that is the one
 * status in which the library needs a user gesture. Sending is enabled as soon as a write would be
 * accepted - while connecting and reconnecting a write waits for the connection, up to
 * `connection.writeTimeoutMs`.
 *
 * @param {string} status
 */
function showStatus(status) {
  ui.status.textContent = status;
  ui.status.setAttribute('data-status', status);
  ui.statusHint.textContent =
    STATUS_HINTS[status] ??
    `The library reports a status this page does not know ("${status}"). Nothing is broken.`;

  ui.connect.hidden = status !== SerialBrokerStatus.AwaitingPermission;
  ui.retry.hidden = status !== SerialBrokerStatus.Failed && status !== SerialBrokerStatus.Released;
  ui.release.disabled = status === SerialBrokerStatus.Released;

  const acceptsWrites =
    status === SerialBrokerStatus.Open ||
    status === SerialBrokerStatus.Connecting ||
    status === SerialBrokerStatus.Reconnecting;
  ui.sendInput.disabled = !acceptsWrites;
  ui.send.disabled = !acceptsWrites;

  // A retryable error announced a recovery; the connection being back is the end of it.
  if (status === SerialBrokerStatus.Open && ui.error.classList.contains('retryable')) {
    hideError();
  }
}

/**
 * Shows an error with its code and the remediation sentence the library ships for it.
 *
 * A retryable error is one the library is already recovering from - the device was unplugged,
 * the port did not open this time. It is shown as information, and cleared once the status is
 * `open` again. Everything else stays until dismissed or replaced: it is something for the
 * developer to read.
 *
 * @param {unknown} error
 */
function showError(error) {
  if (isSerialBrokerError(error)) {
    ui.error.classList.toggle('retryable', error.isRetryable);
    ui.errorTitle.textContent = error.isRetryable ? 'Recovering' : 'Error';
    ui.errorCode.textContent = error.code;
    ui.errorMessage.textContent = error.message;
    ui.errorRemediation.textContent = error.remediation;
  } else {
    // Not from the library: a bug in this page, most likely. Shown rather than lost.
    ui.error.classList.remove('retryable');
    ui.errorTitle.textContent = 'Unexpected error';
    ui.errorCode.textContent = error instanceof Error ? error.name : typeof error;
    ui.errorMessage.textContent = error instanceof Error ? error.message : String(error);
    ui.errorRemediation.textContent = 'Not a serial-broker error; check the page script.';
  }
  ui.error.hidden = false;
}

function hideError() {
  ui.error.hidden = true;
  ui.error.classList.remove('retryable');
}

/** @param {import('serial-broker/min').ReceiveEvent} event */
function onReceive(event) {
  // `text` is present because the configuration asks for `decodeText`. The bytes are in
  // `event.data`, always, for a binary protocol.
  const text = (ui.received.textContent ?? '') + (event.text ?? '');
  ui.received.textContent = text.length > RECEIVED_LIMIT ? text.slice(-RECEIVED_LIMIT) : text;
  ui.received.scrollTop = ui.received.scrollHeight;
}

/** @param {import('serial-broker/min').SendEvent} event */
function onSend(event) {
  // Fires in every tab, for every tab's writes: `origin` says whether this tab issued it.
  const from = event.origin === 'local' ? 'this tab' : 'another tab';
  const shown = JSON.stringify(decoder.decode(event.data));
  appendTo(
    ui.sent,
    `${timeOf(event.timestamp)}  ${from}  ${String(event.data.byteLength)} B  ${shown}`,
  );
}

/** @param {import('serial-broker/min').StatusChangeEvent} event */
function onStatusChange(event) {
  showStatus(event.status);
}

/** @param {import('serial-broker/min').ErrorEvent} event */
function onError(event) {
  showError(event.error);
}

/**
 * Whether this tab gave the configuration up because the tab holding the port runs another
 * `maxTabs`. It shows `failed` with CONFIGURATION_CONFLICT and has left the other tabs; `setup()`
 * does not bring it back, a release and a new setup do.
 */
function hasWithdrawn() {
  if (!SerialBroker.exists(CONFIGURATION)) {
    return false;
  }
  const { status, lastErrorCode } = SerialBroker.getStatus(CONFIGURATION);
  return (
    status === SerialBrokerStatus.Failed &&
    lastErrorCode === SerialBrokerErrorCode.CONFIGURATION_CONFLICT
  );
}

/**
 * Registers the configuration and wires the page to it.
 *
 * Runs on every load. A device the browser was granted on an earlier visit opens with no prompt;
 * otherwise the status becomes `awaiting-permission` and the connect button appears.
 */
async function start() {
  ui.statusHint.textContent = 'Registering the configuration…';
  try {
    await SerialBroker.setup(CONFIGURATION, OPTIONS);
  } catch (error) {
    // The options were rejected, or this tab's environment refuses to take part. The retry button
    // is the way back once the cause named in the error is fixed.
    showError(error);
    ui.status.textContent = 'not set up';
    ui.status.setAttribute('data-status', 'failed');
    ui.statusHint.textContent = 'The configuration could not be set up in this tab.';
    ui.retry.hidden = false;
    return;
  }

  // Named functions: _Set up again_ on a failed configuration runs this with the listeners still
  // subscribed, and the library adds the same function only once.
  SerialBroker.subscribe(CONFIGURATION, 'onStatusChange', onStatusChange);
  SerialBroker.subscribe(CONFIGURATION, 'onReceive', onReceive);
  SerialBroker.subscribe(CONFIGURATION, 'onSend', onSend);
  SerialBroker.subscribe(CONFIGURATION, 'onError', onError);
}

ui.connect.addEventListener('click', () => {
  // Called synchronously in the click handler, and nothing awaited before it: the browser shows
  // its port picker only during the transient activation of a user gesture, and an `await` in
  // front of this call would use the gesture up. The library cannot do this step for you.
  SerialBroker.requestAccess(CONFIGURATION).then((granted) => {
    if (!granted) {
      ui.statusHint.textContent =
        'The picker was closed without a choice. Choose the device when you are ready.';
    }
  }, showError);
});

ui.retry.addEventListener('click', () => {
  ui.retry.hidden = true;
  // `setup()` with the same options starts a failed configuration again, from any tab, and sets a
  // released one up anew. The one exception is a tab that withdrew with CONFIGURATION_CONFLICT
  // because the tab holding the port runs another `maxTabs`: only a release brings that one back.
  const released = hasWithdrawn() ? SerialBroker.release(CONFIGURATION) : Promise.resolve();
  released.then(start).catch(showError);
});

ui.release.addEventListener('click', () => {
  ui.release.disabled = true;
  // This tab only. The other tabs keep the device, and if this one held the port, another takes
  // it over. Pass `{ forgetDevice: true }` to also revoke the browser's permission.
  SerialBroker.release(CONFIGURATION).catch(showError);
});

ui.sendForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const line = ui.sendInput.value + (LINE_ENDINGS[ui.lineEnding.value] ?? '');
  ui.sendInput.value = '';
  // Resolves once the bytes were handed to the device, by whichever tab holds the port. A refused
  // write - timed out, the device gone mid-write - is reported here, not through `onError`.
  SerialBroker.send(CONFIGURATION, line).catch(showError);
});

ui.clearReceived.addEventListener('click', () => {
  ui.received.textContent = '';
});

ui.errorDismiss.addEventListener('click', hideError);

ui.configurationName.textContent = CONFIGURATION;
ui.protocolVersion.textContent = String(PROTOCOL_VERSION);

SerialBroker.configure({
  workerUrl: WORKER_URL,
  // The library writes nothing to the console on its own. Its warnings and errors - the fallback
  // to a BroadcastChannel when the worker script does not load, for one - go to the page instead,
  // where whoever installs the application sees them without opening the developer tools.
  logger: {
    log(level, message, fields) {
      if (level === 'warn' || level === 'error') {
        ui.logSection.hidden = false;
        appendTo(ui.log, `${timeOf(Date.now())}  ${level}  ${message}  ${JSON.stringify(fields)}`);
      }
    },
  },
});

if (isSupported()) {
  void start();
} else {
  // Web Serial or Web Locks is missing - browsers offer neither outside a secure context - or
  // there is no message bus at all. Nothing below can work, so the page says so and stops.
  ui.unsupported.hidden = false;
  ui.unsupportedReason.textContent =
    'Web Serial is not available here. It needs Chrome, Edge or another Chromium browser, and a secure context: HTTPS, or localhost during development.';
  ui.status.textContent = 'unavailable';
  ui.status.setAttribute('data-status', 'failed');
  ui.statusHint.textContent = 'Not supported in this browser.';
}
