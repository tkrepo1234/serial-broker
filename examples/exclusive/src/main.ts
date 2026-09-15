/**
 * One tab at a time on a device: serial-broker with `maxTabs: 1`.
 *
 * The device here is a cutter - something whose commands must not interleave from two screens.
 * Every tab of the origin sets the same configuration up; the first one uses the device, every
 * other one shows `queued` and takes over, in arrival order, as soon as the tab in front of it
 * releases the device, closes or crashes. The application does nothing for that: the browser
 * hands the place on, and the status tells the tab where it stands.
 *
 * Everything the page does is in this one file, top to bottom: the configuration, the library
 * calls, and the rendering of each status. Copy what you need; the README walks through it.
 */

import {
  isSupported,
  SerialBroker,
  SerialBrokerError,
  SerialBrokerErrorCode,
  type ErrorEvent,
  type ReceiveEvent,
  type SendEvent,
  type SerialBrokerOptions,
  type SerialBrokerStatus,
  type StatusChangeEvent,
} from 'serial-broker';
// The broker script has to be served by this origin, under the same URL in every tab: a
// SharedWorker is identified by the URL of its script, and tabs that load it from different
// URLs cannot see each other. Vite's `?url` import gives exactly that - the file is served from
// node_modules while developing and copied into dist/assets/ by the build - so this is the one
// line that names it.
import workerUrl from 'serial-broker/worker?url';

// --- The configuration ------------------------------------------------------------------------

/** The configuration name: the same in every tab, and in every call below. */
const CONFIGURATION = 'Cutter';

/**
 * The options every tab passes. They must be the same in every tab, `maxTabs` included: a tab
 * that finds the device driven under a different limit withdraws with `CONFIGURATION_CONFLICT`.
 */
const OPTIONS: SerialBrokerOptions = {
  // Any port, so that the example runs with whatever adapter is at hand. An application names
  // its device: `device: { vendorId: 0x0403, productId: 0x6001 }`.
  device: { any: true },
  serial: { baudRate: 9600 },
  // The device speaks text; `text` on every received chunk is decoded across chunk boundaries.
  encoding: { decodeText: true },
  // One tab at a time. Every other tab waits with the status `queued`.
  maxTabs: 1,
  // This page sets the configuration up on every load itself, so nothing needs remembering
  // between visits. An application that lets the user configure devices keeps the default and
  // calls `SerialBroker.restore()` on start.
  remember: false,
};

// --- What each status means to the user -------------------------------------------------------

/**
 * One sentence per status, written for the person at the screen. `queued` is the one this
 * example exists for: it is a wait, not an error, and it ends by itself.
 */
const EXPLANATION: Readonly<Record<SerialBrokerStatus, string>> = {
  idle: 'Set up. Connecting starts in a moment.',
  queued:
    'Another tab is using the device. This tab receives nothing until then, and takes over as ' +
    'soon as that tab releases the device or closes - nothing to do here.',
  'awaiting-permission':
    'The browser has not granted a port for this device yet. Choose it once; the browser ' +
    'remembers the choice.',
  connecting: 'Opening the port.',
  open: 'Connected. With maxTabs: 1, this is the only tab using the device.',
  reconnecting: 'The connection was lost. serial-broker is reconnecting by itself; nothing to do.',
  failed:
    'Stopped, and the error below says why. "Use the device again" releases the device in this ' +
    'tab and sets it up anew.',
  released:
    'This tab has released the device. A tab that was waiting takes over now. "Use the device ' +
    'again" joins the queue.',
};

/** Statuses in which a write is accepted: it waits for the port, up to `writeTimeoutMs`. */
const CAN_SEND: ReadonlySet<SerialBrokerStatus> = new Set(['open', 'connecting', 'reconnecting']);

// --- The page ----------------------------------------------------------------------------------

/** Everything received is kept, up to this many characters, oldest dropped first. */
const RECEIVED_LIMIT = 20_000;
/** The event log keeps this many entries. */
const LOG_LIMIT = 200;

const elements = {
  unsupported: byId<HTMLElement>('unsupported'),
  status: byId<HTMLSpanElement>('status'),
  explanation: byId<HTMLSpanElement>('status-explanation'),
  connect: byId<HTMLButtonElement>('connect'),
  release: byId<HTMLButtonElement>('release'),
  setup: byId<HTMLButtonElement>('setup'),
  openSecondTab: byId<HTMLButtonElement>('open-second-tab'),
  error: byId<HTMLElement>('error'),
  errorCode: byId<HTMLElement>('error-code'),
  errorMessage: byId<HTMLElement>('error-message'),
  errorRemediation: byId<HTMLElement>('error-remediation'),
  errorRecovering: byId<HTMLElement>('error-recovering'),
  dismissError: byId<HTMLButtonElement>('dismiss-error'),
  sendForm: byId<HTMLFormElement>('send-form'),
  sendInput: byId<HTMLInputElement>('send-input'),
  sendButton: byId<HTMLButtonElement>('send-button'),
  received: byId<HTMLPreElement>('received'),
  log: byId<HTMLOListElement>('log'),
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`index.html has no element with id "${id}"`);
  }
  return element as T;
}

// --- Rendering ---------------------------------------------------------------------------------

function renderStatus(status: SerialBrokerStatus): void {
  elements.status.textContent = status;
  elements.status.dataset['status'] = status;
  elements.explanation.textContent = explain(status);

  // `released` is delivered as the configuration's last event; by then `exists()` is false.
  const isSetUp = SerialBroker.exists(CONFIGURATION);
  elements.connect.hidden = status !== 'awaiting-permission';
  elements.release.hidden = !isSetUp;
  elements.setup.hidden = isSetUp && status !== 'failed';
  elements.sendButton.disabled = !CAN_SEND.has(status);
}

function explain(status: SerialBrokerStatus): string {
  // The status union grows over time. A status this page does not know is shown as a wait, with
  // its name, rather than as a failure.
  return Object.hasOwn(EXPLANATION, status)
    ? EXPLANATION[status]
    : `The library reports "${status}", which this page does not know yet.`;
}

function showError(error: SerialBrokerError): void {
  elements.errorCode.textContent = error.code;
  elements.errorMessage.textContent = error.message;
  // Every code ships a remediation sentence; show it rather than the message alone.
  elements.errorRemediation.textContent = error.remediation;
  // A retryable error is one the library is already recovering from: information, not a failure.
  elements.errorRecovering.hidden = !error.isRetryable;
  elements.error.dataset['retryable'] = String(error.isRetryable);
  elements.error.hidden = false;
  log(`${error.code}: ${error.message}`);
}

function hideError(): void {
  elements.error.hidden = true;
}

function appendReceived(text: string): void {
  const joined = elements.received.textContent + text;
  elements.received.textContent = joined.slice(-RECEIVED_LIMIT);
  elements.received.scrollTop = elements.received.scrollHeight;
}

function log(message: string): void {
  const entry = document.createElement('li');
  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString();
  entry.append(time, message);
  elements.log.prepend(entry);
  while (elements.log.children.length > LOG_LIMIT) {
    elements.log.lastElementChild?.remove();
  }
}

/** Anything a call rejects with is shown in the error panel; anything else is a bug in the page. */
function report(error: unknown): void {
  if (error instanceof SerialBrokerError) {
    showError(error);
    return;
  }
  throw error;
}

// --- The library calls -------------------------------------------------------------------------

const onStatusChange = (event: StatusChangeEvent): void => {
  log(`${event.previousStatus} -> ${event.status}`);
  renderStatus(event.status);
};

const onReceive = (event: ReceiveEvent): void => {
  // `text` is present because `decodeText` is on; the bytes are in `event.data` as well.
  appendReceived(event.text ?? `${String(event.data.byteLength)} bytes`);
};

const onSend = (event: SendEvent): void => {
  // Fires for every write the browser took for the port - which says nothing about whether the
  // device received it. With `maxTabs: 1` only this tab can have
  // issued it, so `origin` is always 'local' here; a larger limit would see 'remote' too.
  log(`sent ${String(event.data.byteLength)} bytes (${event.origin})`);
};

const onError = (event: ErrorEvent): void => {
  showError(event.error);
};

/**
 * Whether this tab gave the configuration up over a different `maxTabs` in the tab holding the
 * port. Such a tab shows `failed` with `CONFIGURATION_CONFLICT` and has left the bus; only a release
 * and a new setup bring it back.
 */
function hasWithdrawn(): boolean {
  if (!SerialBroker.exists(CONFIGURATION)) {
    return false;
  }
  const { status, lastErrorCode } = SerialBroker.getStatus(CONFIGURATION);
  return status === 'failed' && lastErrorCode === SerialBrokerErrorCode.CONFIGURATION_CONFLICT;
}

/**
 * Sets the configuration up in this tab and subscribes to it.
 *
 * `setup()` resolves once the configuration is registered, not once the port is open; the status
 * events tell the rest. The subscriptions are made after it, because a configuration that is not
 * set up has nothing to subscribe to, and they end with the configuration when it is released -
 * hence this runs again for "Use the device again".
 *
 * After `failed` the configuration is still set up, and `setup()` with the same options starts it
 * again, whichever tab holds the port - a working or reconnecting one it leaves alone. The
 * subscriptions below are the same functions, so making them again adds nothing. The exception is
 * a tab that withdrew with `CONFIGURATION_CONFLICT` because the tab holding the port runs another
 * `maxTabs`: `setup()` does not bring that one back, so it is released first.
 */
async function useTheDevice(): Promise<void> {
  hideError();
  try {
    if (hasWithdrawn()) {
      await SerialBroker.release(CONFIGURATION);
    }
    await SerialBroker.setup(CONFIGURATION, OPTIONS);
  } catch (error) {
    renderStatus('failed');
    report(error);
    return;
  }
  SerialBroker.subscribe(CONFIGURATION, 'onStatusChange', onStatusChange);
  SerialBroker.subscribe(CONFIGURATION, 'onReceive', onReceive);
  SerialBroker.subscribe(CONFIGURATION, 'onSend', onSend);
  SerialBroker.subscribe(CONFIGURATION, 'onError', onError);
  // The status may have moved on between `setup()` resolving and the subscriptions being made.
  const { status } = SerialBroker.getStatus(CONFIGURATION);
  log(`set up, ${status}`);
  renderStatus(status);
}

/**
 * Shows the browser's port picker.
 *
 * `requestAccess()` must be called synchronously inside the click: the browser shows its picker
 * only during the transient activation of a user gesture, and any `await` before the call
 * consumes it. Nothing else in this handler comes first.
 */
elements.connect.addEventListener('click', () => {
  SerialBroker.requestAccess(CONFIGURATION)
    .then((granted) => {
      if (!granted) {
        log('the port picker was dismissed');
      }
    })
    .catch(report);
});

/**
 * Gives the device up in this tab. The next tab in the queue takes over; this tab shows
 * `released` and can join the queue again with "Use the device again".
 */
elements.release.addEventListener('click', () => {
  elements.release.disabled = true;
  SerialBroker.release(CONFIGURATION)
    .catch(report)
    .finally(() => {
      elements.release.disabled = false;
    });
});

/**
 * Starts over: after `released` this joins the queue behind whoever took over; after `failed` it
 * sets the configuration up again, which tries again (see `useTheDevice()`).
 */
elements.setup.addEventListener('click', () => {
  elements.setup.disabled = true;
  void useTheDevice().finally(() => {
    elements.setup.disabled = false;
  });
});

elements.openSecondTab.addEventListener('click', () => {
  window.open(window.location.href, '_blank');
});

elements.dismissError.addEventListener('click', hideError);

/**
 * Sends the line. The write is accepted while the port is open, opening or reconnecting; it
 * waits for the port up to `connection.writeTimeoutMs` (5 s by default) and rejects with
 * `WRITE_TIMEOUT` afterwards. Nothing is appended by the library, so the newline the device
 * expects is added here.
 */
elements.sendForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const line = elements.sendInput.value;
  if (line.length === 0) {
    return;
  }
  elements.sendInput.value = '';
  SerialBroker.send(CONFIGURATION, `${line}\n`).catch(report);
});

/**
 * Says goodbye at once when the page goes away, so that the next tab in the queue takes over
 * without waiting for the browser to tear this one down. Closing the tab without this works too;
 * the browser frees this tab's place as it dies. See "Leaving the page" in the shared-ports
 * chapter.
 */
window.addEventListener('pagehide', () => {
  void SerialBroker.dispose();
});

// --- Start -------------------------------------------------------------------------------------

async function start(): Promise<void> {
  // Without a device: `?stand-in` installs the Web Serial stand-in the repository's browser tests
  // use, before the library first reads `navigator.serial`. It behaves like a granted loopback
  // adapter - everything sent comes back. Development only; the production build leaves it out.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('stand-in')) {
    const { installWebSerialStandIn } =
      await import('../../../test/browser/stand-in/web-serial-stand-in.ts');
    installWebSerialStandIn({ devices: [{ id: 'loopback', granted: true }] });
  }

  if (!isSupported()) {
    elements.unsupported.hidden = false;
    renderStatus('failed');
    elements.explanation.textContent = 'Not supported in this browser.';
    elements.setup.hidden = true;
    return;
  }

  // Library-wide settings go before the first `setup()`; they are read when the library builds
  // its internals. A `logger` here would receive the library's diagnostics - it logs nothing on
  // its own.
  SerialBroker.configure({ workerUrl });
  await useTheDevice();
}

void start();
