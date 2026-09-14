/**
 * The complete integration of serial-broker into one page: set up a configuration, show its
 * status, print what the device sends, send a line, and ask for permission when the browser
 * needs a click.
 *
 * Nothing here refers to tabs. Every tab runs this same script; serial-broker decides which of
 * them holds the port, and every tab receives the data and can send.
 */
import { SerialBroker, SerialBrokerError, type SerialBrokerStatus } from 'serial-broker';
// Tabs coordinate through a SharedWorker, identified by the URL of its script: every tab has to
// load the same file from this origin. Vite's `?url` import serves it in development and copies it
// into the build. Without a bundler, copy dist/serial-broker.worker.js next to the page instead.
import workerUrl from 'serial-broker/worker?url';

/** The configuration name. Every call addresses the device by it, in every tab alike. */
const NAME = 'Device';

// The page's elements. The ids are stable: smoke.spec.ts drives the page through them.
const status = byId<HTMLElement>('status');
const statusHint = byId<HTMLElement>('status-hint');
const connectButton = byId<HTMLButtonElement>('connect');
const errorBox = byId<HTMLElement>('error');
const errorCode = byId<HTMLElement>('error-code');
const errorMessage = byId<HTMLElement>('error-message');
const errorRemediation = byId<HTMLElement>('error-remediation');
const received = byId<HTMLPreElement>('received');
const sendForm = byId<HTMLFormElement>('send-form');
const sendInput = byId<HTMLInputElement>('send-input');
const sendButton = byId<HTMLButtonElement>('send-button');

/** One sentence per status, so that whoever looks at the page knows what it is waiting for. */
const STATUS_HINT: Readonly<Record<SerialBrokerStatus, string>> = {
  idle: 'Registered, not connecting yet.',
  queued: 'Waiting for a place: other tabs use the device already.',
  'awaiting-permission': 'The browser has to be told which port the device is.',
  connecting: 'Opening the port…',
  open: 'Connected. Everything the device sends appears below.',
  reconnecting: 'The connection was lost. Trying again by itself.',
  failed: 'Gave up reconnecting. Plug the device in again, or reload the page.',
  released: 'This tab no longer uses the device.',
};

async function main(): Promise<void> {
  // Before the first setup(): the worker URL cannot change once a tab has connected to it.
  SerialBroker.configure({ workerUrl });

  // setup() runs on every page load and resolves as soon as the configuration is registered,
  // not when the port is open: opening may need the user (see the connect button). It fails
  // where there is no Web Serial - outside Chromium, or outside https:// and localhost.
  try {
    await SerialBroker.setup(NAME, {
      // Any port the user has granted. For one kind of device, name it by its USB ids instead,
      // e.g. { vendorId: 0x1a86, productId: 0x7523 } for a CH340 adapter.
      device: { any: true },
      serial: { baudRate: 9600 },
      // Deliver event.text next to the raw event.data.
      encoding: { decodeText: true },
    });
  } catch (error) {
    showError(error);
    return;
  }

  SerialBroker.subscribe(NAME, 'onStatusChange', (event) => {
    showStatus(event.status);
  });
  SerialBroker.subscribe(NAME, 'onReceive', (event) => {
    // A chunk is an arbitrary piece of the byte stream, not a line: it is appended as it comes,
    // and the device's own line endings make the lines.
    appendReceived(event.text ?? '');
  });
  SerialBroker.subscribe(NAME, 'onError', (event) => {
    // Failures without a call to answer for them: the device unplugged, the port not opening.
    showError(event.error);
  });
  // The status may already have changed between setup() and the subscription above.
  showStatus(SerialBroker.getStatus(NAME).status);

  connectButton.addEventListener('click', () => {
    // requestAccess() has to be the first thing in the click handler. The browser shows its port
    // picker only during the click, and an `await` before the call uses the click up.
    SerialBroker.requestAccess(NAME).then((granted) => {
      // `false` is not an error: the user closed the picker. The button stays for another try.
      if (!granted) {
        statusHint.textContent = 'No port was chosen. Press Connect to choose one.';
      }
    }, showError);
  });

  sendForm.addEventListener('submit', (event) => {
    event.preventDefault();
    // Nothing is appended to what is sent: the line ending is the application's decision.
    // The promise resolves once the bytes were handed to the device, whichever tab holds it.
    SerialBroker.send(NAME, `${sendInput.value}\r\n`).then(() => {
      sendInput.value = '';
    }, showError);
  });
}

function showStatus(value: SerialBrokerStatus): void {
  status.textContent = value;
  status.dataset['status'] = value;
  // The set of status values may grow in a later version; an unknown one is shown as it is.
  statusHint.textContent = value in STATUS_HINT ? STATUS_HINT[value] : '';
  // The only status that needs the user: the browser asks which port from a click, nowhere else.
  connectButton.hidden = value !== 'awaiting-permission';
  // A write issued while the port is not open would wait for it, and fail with WRITE_TIMEOUT
  // after connection.writeTimeoutMs. Saying so up front is clearer than a delayed error.
  sendButton.disabled = value !== 'open';
  if (value === 'open') {
    errorBox.hidden = true;
  }
}

function showError(error: unknown): void {
  if (!(error instanceof SerialBrokerError)) {
    errorCode.textContent = 'Error';
    errorMessage.textContent = String(error);
    errorRemediation.textContent = '';
  } else {
    // code is stable across versions - branch on it, never on the message. remediation is one
    // sentence saying what to do. isRetryable means the library is already recovering and the
    // status shows it, so the page presents such an error as a note rather than as a problem.
    errorCode.textContent = error.code;
    errorMessage.textContent = error.message;
    errorRemediation.textContent = error.remediation;
    errorBox.dataset['retryable'] = String(error.isRetryable);
  }
  errorBox.hidden = false;
}

function appendReceived(text: string): void {
  // A tab on an operator's screen stays open for weeks: keep the last 20 000 characters only.
  received.textContent = ((received.textContent ?? '') + text).slice(-20_000);
  received.scrollTop = received.scrollHeight;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`index.html has no element with the id "${id}".`);
  }
  return element as T;
}

void main();
