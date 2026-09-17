# Serial-Broker-Terminal

A serial terminal: open a port, watch what the device says, type back. It is the first
application built on [serial-broker](../../README.md), and the one to read first — everything a
terminal is expected to do, and nothing else.

Static HTML, an import map and one script the browser loads as it is. No bundler, no build step,
no framework, no dependencies at run time.

![The window: a header with the connection, a log, and an input line.](#)

## What it does

- **Connect, disconnect, reconnect.** The status is the library's own word for it — `open`,
  `reconnecting`, `awaiting-permission`, `queued`, `failed` — and _Connect_ appears exactly while
  the browser's port picker is what is needed.
- **Connection settings**: baud rate, data bits, stop bits, parity, flow control. Applying them
  connects again with the new ones, in this tab; other tabs keep theirs.
- **Send text or hex**, with the line ending you choose (CR LF, LF, CR or nothing). `↑` and `↓`
  walk through what you sent earlier.
- **Display options**: hex view with an offset column and the printable characters beside it, ANSI
  colours, timestamps, auto-scroll, and whether your own writes are echoed into the log.
  `Ctrl+H` toggles hex. (`Ctrl+T` is the browser's own shortcut for a new tab in Chrome and Edge,
  so a page cannot have it.)
- **Save the log** to a file, and clear the terminal.
- **Dark and light**, remembered, starting from what the system asks for.
- **Experimental: send a file** as raw bytes, in chunks, with a pause between them.

The display options, the theme and the connection settings are remembered between visits, as are
the send mode and the line ending. The log itself is not.

## What serial-broker does for it

Open the terminal in a second tab and watch: **both show the same traffic**, both can send, and
only one of them holds the port. Close that one, and another takes the device over without a
prompt — the page does not notice, because it never asks which tab holds the port.

That is the whole reason this application is some 650 lines and not 5 000: the failover, the
reconnection after an unplugged adapter, the ordering of writes from two tabs, the permission that
survives a reload, and the errors with a remediation sentence are the library's, not the page's.

## Running it

The terminal uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/terminal
npm install
npm start          # serves http://localhost:8161/
```

**Without a device:** open <http://localhost:8161/?stand-in>. That installs the repository's Web
Serial stand-in — a loopback adapter that echoes everything sent — before the library looks for
`navigator.serial`. It exists in development only; `npm run build` does not copy it.

| Command             | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `npm start`         | Serves the terminal at <http://localhost:8161/>.                     |
| `npm run typecheck` | `tsc` with `checkJs` over the page, against the library's own types. |
| `npm run build`     | Assembles `dist/`: the page and the four library files it loads.     |

Chrome or Edge is required — Web Serial exists nowhere else — and a secure context, which
`localhost` counts as.

## Deploying it

`npm run build` writes `dist/`:

```
dist/
├── index.html
├── terminal.css
├── terminal.js
└── serial-broker/
    ├── serial-broker.min.js
    ├── serial-broker.min.js.map
    ├── serial-broker.worker.js
    └── serial-broker.worker.js.map
```

Copy that folder to any web server. Two things matter, and both are in the page already:

- The **import map** in `index.html` maps the bare specifier `serial-broker` to
  `/serial-broker/serial-broker.min.js`. Move the folder, and that one line moves with it.
- **`configure({ workerUrl })`** names `/serial-broker/serial-broker.worker.js`. A `SharedWorker`
  is identified by the URL of its script, so every tab has to name the same one, and it has to be
  served from this origin. Without it the tabs would each get a worker of their own and stop
  sharing the port.

## Taking it into an application of your own

`public/terminal.js` is the whole integration, and it is four calls:

```js
SerialBroker.configure({ workerUrl: '/serial-broker/serial-broker.worker.js' });
await SerialBroker.setup('Terminal', { device: { any: true }, serial: { baudRate: 9600 } });
SerialBroker.subscribe('Terminal', 'onReceive', (event) => show(event.text));
await SerialBroker.send('Terminal', new TextEncoder().encode('PING\r\n'));
```

The rest of the file is the terminal: the log, the hex dump, the ANSI colours, the dialogs. Take
the four calls and leave the rest, or take the file and change what it shows.

Two decisions worth copying:

- **The configuration is named, and every tab uses the same name.** That is what makes two tabs one
  terminal. A second configuration name would be a second device.
- **Nothing is appended to what you send.** The line ending is the application's decision, which is
  why it sits in a dropdown next to the input. Devices disagree about it, and a library that
  guessed would be wrong on half of them.

## Design decisions

- **Width-capped.** The window is capped at 68 rem and centred. On an ultra-wide screen a terminal
  that fills the display puts the input a metre away from the log it belongs to, and a line of
  device output is unreadable long before it wraps.
- **ANSI colours, not an ANSI terminal.** The escape sequences for the eight colours, their bright
  forms and bold are honoured; cursor movement and clearing are dropped rather than acted on. This
  is a log, and a device must not be able to erase what it wrote a minute ago.
- **The log is bounded** at 2 000 deliveries - one line each, except a hex dump, which is one
  delivery over several rows. A terminal left open on a station for a week must not grow
  until the tab dies.
- **The file transfer is not a protocol.** No XMODEM, no acknowledgement, no retry: the bytes go
  out in chunks with a pause between them, and the operator watches what comes back. It is marked
  experimental because that is what it is — enough for a device that takes a stream, not enough for
  one that needs flow control it does not have.
- **Preferences live in `localStorage`**, one key, best-effort: a private window that refuses
  storage gets the defaults and a working terminal, not an error.

## Element ids the smoke test drives

`#status`, `#connect`, `#release`, `#send-input`, `#send-button`, `#send-mode`, `#received`,
`#error`, `#error-code`, `#error-remediation`, `#more`, `#opt-hex`, `#display-summary`.

`smoke.spec.ts` connects to a granted device, asks for one with a click, lives through an unplugged
adapter, disconnects and connects again, and checks that hex survives a reload.
