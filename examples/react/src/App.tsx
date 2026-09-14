/**
 * The application: a header with the status, and a device panel with the connect button, the
 * error, the received lines and a send form. Both components call `useSerialBroker()` with the same
 * name and share one store - no props, no context provider.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SerialBrokerError, SerialBrokerOptions } from 'serial-broker';

import { useSerialBroker, type SerialLine } from './lib/serial-broker-react/index.js';
import { present } from './status.js';

/** The configuration name. Every tab and every component addresses the device by it. */
const DEVICE = 'Device';

/**
 * Declared once, outside the components: the same options in every tab and every render.
 */
const DEVICE_OPTIONS: SerialBrokerOptions = {
  // Any port the user grants. For one kind of device, name it by its USB ids instead,
  // e.g. { vendorId: 0x1a86, productId: 0x7523 } for a CH340 adapter.
  device: { any: true },
  serial: { baudRate: 9600 },
  // Deliver text next to the raw bytes, so the hook can assemble lines.
  encoding: { decodeText: true },
};

export function App() {
  return (
    <>
      <Header />
      <main>
        <DevicePanel />
        <p className="note">
          Open this page in a second tab: both show the same status, both receive, both can send.
          One of them holds the port; close it, and the other takes over.
        </p>
      </main>
    </>
  );
}

function Header() {
  const { status } = useSerialBroker(DEVICE, DEVICE_OPTIONS);
  const presentation = present(status);
  return (
    <header>
      <h1>
        serial-broker <small>in React</small>
      </h1>
      <span id="header-status" className="badge" data-tone={presentation.tone}>
        {presentation.label}
      </span>
    </header>
  );
}

function DevicePanel() {
  const { status, lastError, lines, connect, send, release, restart, dismissError } =
    useSerialBroker(DEVICE, DEVICE_OPTIONS);
  const presentation = present(status);
  const [line, setLine] = useState('');

  const onSend = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // The line ending is the application's decision: the library appends nothing.
    void send(`${line}\r\n`).then((sent) => {
      if (sent) {
        setLine('');
      }
    });
  };

  return (
    <section aria-labelledby="device-heading">
      <h2 id="device-heading">{DEVICE}</h2>

      <p className="status">
        <code id="status" className="badge" data-tone={presentation.tone}>
          {status}
        </code>{' '}
        <span id="status-hint">{presentation.hint}</span>
      </p>

      <p className="actions">
        {status === 'awaiting-permission' && (
          // The only status that needs the user. connect() is the first thing the handler does:
          // the browser shows its port picker only during the click.
          <button id="connect" type="button" onClick={() => void connect()}>
            Connect…
          </button>
        )}
        {status !== 'released' && (
          <button id="release" type="button" onClick={() => void release()}>
            Release the device
          </button>
        )}
        {(status === 'released' || status === 'failed') && (
          <button id="restart" type="button" onClick={() => void restart()}>
            Use the device again
          </button>
        )}
      </p>

      {lastError !== null && <ErrorBox error={lastError} onDismiss={dismissError} />}

      <Received lines={lines} />

      <form id="send-form" onSubmit={onSend}>
        <input
          id="send-input"
          aria-label="Line to send"
          placeholder="Line to send, CR LF is appended"
          autoComplete="off"
          value={line}
          onChange={(event) => {
            setLine(event.target.value);
          }}
        />
        {/* A write issued while the port is not open waits for it and may end in WRITE_TIMEOUT.
            A button that cannot be pressed says so sooner. */}
        <button id="send-button" type="submit" disabled={status !== 'open'}>
          Send
        </button>
      </form>
    </section>
  );
}

function ErrorBox({ error, onDismiss }: { error: SerialBrokerError; onDismiss: () => void }) {
  return (
    // isRetryable: the library is already recovering and the status shows it - a note, not a
    // problem. It clears itself once the port is open again; any other error stays until dismissed.
    <div id="error" role="alert" data-retryable={String(error.isRetryable)}>
      <p>
        {/* code is stable across versions: branch on it, never on the message. */}
        <strong id="error-code">{error.code}</strong>{' '}
        <span id="error-message">{error.message}</span>{' '}
        <time dateTime={new Date(error.timestamp).toISOString()}>
          {new Date(error.timestamp).toLocaleTimeString()}
        </time>
      </p>
      <p id="error-remediation">{error.remediation}</p>
      <button id="error-dismiss" type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

function Received({ lines }: { lines: readonly SerialLine[] }) {
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // Follow the newest line, inside the list only: the page itself stays where the user put it.
    if (list.current !== null) {
      list.current.scrollTop = list.current.scrollHeight;
    }
  }, [lines]);

  return (
    <ol id="received" ref={list} aria-label="Received lines">
      {lines.map((received) => (
        <li key={received.id} data-complete={String(received.complete)}>
          {received.text}
        </li>
      ))}
    </ol>
  );
}
