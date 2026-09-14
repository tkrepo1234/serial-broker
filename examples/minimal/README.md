# The smallest page that works

One page that connects to a serial device through [serial-broker](../../README.md), prints what
the device sends, and sends a line. Vite, TypeScript, plain DOM, no framework:
[`index.html`](index.html) and [`src/main.ts`](src/main.ts), 146 lines including the comments.
This is the integration, with the page's own plumbing left out:

```ts
import { SerialBroker, SerialBrokerError } from 'serial-broker';
import workerUrl from 'serial-broker/worker?url';

// Tabs coordinate through a SharedWorker, identified by the URL of its script. Every tab has to
// load the same file from this origin - before the first setup().
SerialBroker.configure({ workerUrl });

// Registers the configuration; resolves when it is registered, not when the port is open.
await SerialBroker.setup('Device', {
  device: { any: true }, // or { vendorId: 0x1a86, productId: 0x7523 } for one kind of device
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});

SerialBroker.subscribe('Device', 'onStatusChange', (event) => showStatus(event.status));
SerialBroker.subscribe('Device', 'onReceive', (event) => appendReceived(event.text ?? ''));
SerialBroker.subscribe('Device', 'onError', (event) => showError(event.error));
showStatus(SerialBroker.getStatus('Device').status); // it may have changed before subscribing

// Shown only while the status is 'awaiting-permission': the browser shows its port picker
// during a click and nowhere else. requestAccess() comes first in the handler - no await before it.
connectButton.addEventListener('click', () => {
  SerialBroker.requestAccess('Device').then((granted) => {
    /* false: the user closed the picker */
  }, showError);
});

// Nothing is appended: the line ending is the application's decision. Resolves once the bytes
// were handed to the device, whichever tab holds it.
SerialBroker.send('Device', `${line}\r\n`).catch(showError);

// Every error carries a stable code and a remediation sentence; isRetryable means the library is
// already recovering and the status shows it.
function showError(error: unknown): void {
  if (error instanceof SerialBrokerError) {
    show(error.code, error.message, error.remediation, error.isRetryable);
  }
}
```

Open the page in two tabs: both show the same status, both receive, both can send. One of them
holds the port; close it, and the other takes over. Nothing in the script refers to tabs.

## What it shows

- **Every status, named and explained.** `idle`, `queued`, `awaiting-permission`, `connecting`,
  `open`, `reconnecting`, `failed` and `released` each have a one-sentence hint, so whoever looks
  at the page knows what it is waiting for. A status this page does not know is shown as it is:
  the set may grow.
- **The connect button only where a click is needed.** It appears with `awaiting-permission` and
  disappears once the port is open. Later visits open the port with no click, because the browser
  remembers the choice.
- **Errors with code, message and remediation**, from `onError` and from the calls the page
  makes. A retryable error - one the library is already recovering from - is shown as a note, not
  as a problem. The box clears when the port is open again.
- **Received text**, appended as it arrives. A chunk is not a line; the device's line endings make
  the lines. The last 20 000 characters are kept, because a tab on an operator's screen stays open
  for weeks.
- **Sending**, enabled only while the port is open. A write issued earlier would wait for the port
  and fail with `WRITE_TIMEOUT` after five seconds; saying so up front is clearer.

## Running it

The application uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/minimal
npm install
npm start          # serves http://localhost:8151/
```

| Command             | What it does                                                            |
| ------------------- | ----------------------------------------------------------------------- |
| `npm start`         | Serves the page at <http://localhost:8151/> with Vite's dev server.     |
| `npm run typecheck` | `tsc --noEmit` over `src/`.                                             |
| `npm run build`     | A production build in `dist/`: one page, one script, the worker script. |
| `npm run preview`   | Serves that build on the same port.                                     |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. Without a device you still see the page: the status is
`awaiting-permission`, and _Connect…_ opens the browser's port picker. A USB-serial adapter with its
TX and RX pins bridged echoes every line you send.

The smoke test runs the page against the Web Serial stand-in instead of a device, from the
repository root:

```sh
npm run test:examples -- examples/minimal/smoke.spec.ts
```

## Taking it into your own application

1. **Install the library:** `npm install serial-broker`.
2. **Serve the worker script from your origin.** With Vite, nothing needs to be done: it finds
   `serial-broker.worker.js` through the library's own
   `new URL('./serial-broker.worker.js', import.meta.url)`, and
   [Installing](../../docs/site/installing.md#the-worker-script) says which other bundlers do the
   same. This page still names the URL explicitly, with
   `import workerUrl from 'serial-broker/worker?url'` and `SerialBroker.configure({ workerUrl })`,
   so it is visible in one place. With another toolchain, copy
   `node_modules/serial-broker/dist/serial-broker.worker.js` to your static files and pass that
   path to `configure()` instead. Every tab must load it from the same URL.
3. **Copy the calls above** into your page: `setup()` on every load, the three subscriptions,
   `getStatus()` after subscribing.
4. **Name your device.** Replace `device: { any: true }` with its USB ids, and `baudRate` with the
   device's. On Windows the ids are in Device Manager under _Hardware Ids_ (`VID_1A86&PID_7523`);
   the library's [debugging surface](../../docs/site/diagnostics.md) reads them off the device.
5. **Show a connect button only for `awaiting-permission`**, and call `requestAccess()` first
   thing in its click handler.
6. **Show `code` and `remediation`** of every `SerialBrokerError`, and branch on `code` where the
   application has to decide - never on `message`.

## Stable element ids

| Element                      | Id                  |
| ---------------------------- | ------------------- |
| Status, the raw value        | `status`            |
| Status hint, one sentence    | `status-hint`       |
| Connect button               | `connect`           |
| Error box (`hidden` if none) | `error`             |
| Error code                   | `error-code`        |
| Error message                | `error-message`     |
| Error remediation            | `error-remediation` |
| Received text                | `received`          |
| Send form                    | `send-form`         |
| Send input                   | `send-input`        |
| Send button                  | `send-button`       |

`#status` also carries the value in `data-status`, and `#error` carries `data-retryable`, for
styling.

## Design decisions

**The worker URL is named explicitly, through Vite's `?url` import.** Vite would find the script
without it: its dependency optimizer rewrites the library's `new URL(..., import.meta.url)` to
`/node_modules/serial-broker/dist/serial-broker.worker.js` in development, and the build emits the
script as an asset. Naming it costs two lines, makes the URL visible in one place - the network
tab shows exactly that file - and is the line to change when another toolchain serves the script
from elsewhere. In this repository the library is linked (`file:../..`) rather than installed, so
the dev server serves it as source through `/@fs/`, and the same two lines cover that case too.

**`device: { any: true }`.** The page cannot know the reader's device, and a first page should
connect to whatever the user picks. The comment next to it says how to name one kind of device,
and the README says where to find the ids. `any` also means the smoke test's loopback device needs
no ids in the page.

**No `isSupported()` check before `setup()`.** Where Web Serial is missing, `setup()` rejects with
`WEB_SERIAL_UNAVAILABLE`, whose remediation names the browsers that work, and the page shows it
like every other error. `isSupported()` is for deciding _before_ touching the library - hiding a
feature, say - which a page with nothing else on it does not need.

**The send button is disabled unless the port is open.** The library accepts a write in any
status and waits for the port up to `connection.writeTimeoutMs`. For a page that shows the status
next to the button, a button that cannot be pressed says the same thing sooner.

**Retryable errors are shown as a note.** `isRetryable` means the library is already reconnecting,
and the status says so. Hiding such an error would hide what happened; showing it as a problem
would ask the user to do something. The box is styled by `data-retryable`, cleared on `open`, and
set by every error, so that a note left by an earlier error does not soften a later problem.

**A few CSS rules in `index.html`, no stylesheet and no framework.** Enough to tell the states
apart at a glance - open is green, connecting, reconnecting and queued amber, failed red - and
nothing a reader has to remove before copying.

**`<link rel="icon" href="data:,">`.** Without it the browser requests `/favicon.ico`, the dev
server answers 404, and the console shows an error that is not the page's. The smoke test fails on
any console warning or error, so that the page stays quiet.

**The root ESLint configuration ignores this folder**, as it does every example; `npm run
typecheck` is the gate here, and CI runs it. Prettier still formats the folder.

## Files

```
examples/minimal/
├── example.json     port 8151, start command, ready path - read by the root's test runner
├── index.html       the page: status, connect button, error box, received text, send form
├── src/main.ts      the integration, 148 lines with comments
├── smoke.spec.ts    Playwright: loads the page against the stand-in, sends a line, sees it echoed,
│                    unplugs the device and sees the note, plugs it in and sees the port open again
├── tsconfig.json    type-check only; vite/client for the ?url import
└── package.json     vite, typescript, "serial-broker": "file:../.."
```
