/**
 * The demo's application code, and a reasonable template for a real integration.
 *
 * Everything here is ordinary application work: read some settings, call `setup`, subscribe,
 * reflect the status in the UI. Nothing in it knows or cares which tab owns the port - which
 * is the point.
 *
 * Run it with any static server from the repository root, after `npm run build`:
 *
 *     npx serve .
 *
 * then open `examples/demo/` in two or three tabs. Web Serial needs a secure context, so
 * `localhost` works and a plain-HTTP LAN address does not.
 */

import { SerialBroker, SerialBrokerError, type SerialBrokerStatus } from '../../src/index.js';

const CONFIG_NAME = 'DemoDevice';

// The demo is served as static files with no bundler, so the broker script's URL is given
// explicitly. An application built with Vite, webpack or Parcel does not need this: the
// default resolution through `import.meta.url` finds it.
SerialBroker.configure({
  workerUrl: new URL('../../dist/serial-broker.worker.js', import.meta.url),
});

/**
 * Finds an element the page is required to have.
 *
 * The cast is the point: the demo's markup is fixed and next to this file, so a missing
 * element is a mistake to fail loudly on rather than a case to handle.
 */
function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`The demo page is missing #`);
  }
  return found;
}

const ui = {
  vendorId: element('vendorId') as HTMLInputElement,
  productId: element('productId') as HTMLInputElement,
  baudRate: element('baudRate') as HTMLInputElement,
  connect: element('connect') as HTMLButtonElement,
  grant: element('grant') as HTMLButtonElement,
  release: element('release') as HTMLButtonElement,
  payload: element('payload') as HTMLInputElement,
  terminator: element('terminator') as HTMLSelectElement,
  send: element('send') as HTMLButtonElement,
  clear: element('clear') as HTMLButtonElement,
  status: element('statusText'),
  dot: element('dot'),
  log: element('log'),
};

/** Appends one line to the traffic view, oldest first. */
function log(kind: string, text: string, className: string): void {
  const entry = document.createElement('div');
  entry.className = 'entry';

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date().toLocaleTimeString();

  const label = document.createElement('span');
  label.className = `kind ${className}`;
  label.textContent = kind;

  const body = document.createElement('span');
  body.textContent = text;

  entry.append(time, label, body);
  ui.log.append(entry);
  ui.log.scrollTop = ui.log.scrollHeight;
}

/** True when every character is printable, so the text form is worth showing. */
function isPrintable(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    // Tab, carriage return and line feed are expected in serial traffic and stay printable.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      return false;
    }
  }
  return true;
}

/** Renders bytes that are not printable text as hex, so binary traffic is still readable. */
function describe(data: Uint8Array, text: string | undefined): string {
  if (text !== undefined && isPrintable(text)) {
    return JSON.stringify(text);
  }
  return [...data].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function showStatus(status: SerialBrokerStatus): void {
  ui.status.textContent = status;
  ui.dot.className = `dot ${status}`;

  // The only place the demo branches on status: what the user can do next.
  ui.send.disabled = status !== 'open';
  ui.grant.hidden = status !== 'awaiting-permission';
  ui.release.disabled = status === 'released';
}

if (!SerialBroker.isSupported()) {
  log('unsupported', 'This browser has no Web Serial API. Use Chrome, Edge or Opera.', 'err');
  ui.connect.disabled = true;
}

ui.connect.addEventListener('click', () => {
  void (async () => {
    try {
      await SerialBroker.setup(CONFIG_NAME, {
        device: {
          vendorId: Number.parseInt(ui.vendorId.value, 16) || Number(ui.vendorId.value),
          productId: Number.parseInt(ui.productId.value, 16) || Number(ui.productId.value),
        },
        serial: { baudRate: Number(ui.baudRate.value) },
        encoding: { decodeText: true },
      });

      SerialBroker.subscribe(CONFIG_NAME, 'onReceive', (event) => {
        log('received', describe(event.data, event.text), 'rx');
      });

      SerialBroker.subscribe(CONFIG_NAME, 'onSend', (event) => {
        // `origin` is the one thing the library says about who did what, and it says it only
        // about this tab: 'local' means this tab issued the write, 'remote' means some other
        // tab did. It never says which.
        log(
          event.origin === 'local' ? 'sent' : 'sent (peer)',
          describe(event.data, new TextDecoder().decode(event.data)),
          event.origin === 'local' ? 'tx-local' : 'tx-remote',
        );
      });

      SerialBroker.subscribe(CONFIG_NAME, 'onStatusChange', (event) => {
        showStatus(event.status);
        log('status', `${event.previousStatus} -> ${event.status}`, '');
      });

      SerialBroker.subscribe(CONFIG_NAME, 'onError', (event) => {
        log('error', `${event.error.code}: ${event.error.remediation}`, 'err');
      });

      showStatus(SerialBroker.getStatus(CONFIG_NAME).status);
      ui.connect.disabled = true;
      ui.release.disabled = false;
    } catch (error) {
      const reason =
        error instanceof SerialBrokerError
          ? `${error.code}: ${error.message} - ${error.remediation}`
          : String(error);
      log('error', reason, 'err');
    }
  })();
});

// Called straight from the click handler, with no `await` before it: `requestPort()` needs
// transient activation, and any await would have spent it.
ui.grant.addEventListener('click', () => {
  void SerialBroker.requestAccess(CONFIG_NAME).then(
    (granted) => {
      if (!granted) {
        log('permission', 'The picker was dismissed.', '');
      }
    },
    (error: unknown) => {
      log('error', String(error), 'err');
    },
  );
});

ui.send.addEventListener('click', () => {
  void SerialBroker.send(CONFIG_NAME, ui.payload.value + ui.terminator.value).catch(
    (error: unknown) => {
      const reason =
        error instanceof SerialBrokerError ? `${error.code}: ${error.remediation}` : String(error);
      log('error', reason, 'err');
    },
  );
});

ui.payload.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !ui.send.disabled) {
    ui.send.click();
  }
});

ui.release.addEventListener('click', () => {
  void SerialBroker.release(CONFIG_NAME).then(() => {
    ui.connect.disabled = false;
    ui.release.disabled = true;
    ui.send.disabled = true;
    ui.grant.hidden = true;
    ui.status.textContent = 'released';
    ui.dot.className = 'dot';
  });
});

ui.clear.addEventListener('click', () => {
  ui.log.replaceChildren();
});

// Reconnect to whatever was set up on an earlier visit, before the user does anything. The
// browser still holds the device permission, so this is prompt-free.
void SerialBroker.restore().then((restored) => {
  if (restored.includes(CONFIG_NAME)) {
    log('restored', 'Reconnected to the device remembered from an earlier visit.', '');
    ui.connect.click();
  }
});
