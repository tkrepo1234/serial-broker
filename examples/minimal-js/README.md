# The smallest page that works, in plain JavaScript

**The example is one file: [`index.html`](index.html).** The markup, an import map and one inline
`<script type="module">` with the whole integration - nothing is split into modules, nothing is
imported from a folder of the example's own, and there is no build step. Read the file top to
bottom and you have seen everything the page does.

It is deliberately small - the way in for a developer
who writes plain JavaScript and wants to see the library work before reading anything else.

Everything the page does, in the order the file does it:

```js
import { isSerialBrokerError, SerialBroker } from 'serial-broker';

// A SharedWorker is identified by the URL of its script, so every tab has to load the same one,
// from this origin. Always before the first setup().
SerialBroker.configure({ workerUrl: '/serial-broker/serial-broker.worker.js' });

// Registers the configuration; resolves when it is registered, not when the port is open.
await SerialBroker.setup('Device', {
  device: { any: true }, // or { vendorId: 0x1a86, productId: 0x7523 } for one kind of device
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});

SerialBroker.subscribe('Device', 'onStatusChange', (event) => {
  /* event.status */
});
SerialBroker.subscribe('Device', 'onReceive', (event) => {
  /* event.text */
});
SerialBroker.subscribe('Device', 'onError', (event) => {
  /* event.error */
});

// In the click handler and nowhere else: the browser opens its port picker only during a click.
SerialBroker.requestAccess('Device').then(() => undefined, showError);

// Nothing is appended - the line ending is the application's decision.
SerialBroker.send('Device', `${line}\r\n`).then(() => undefined, showError);
```

Open the page in two tabs: both show the same status, both receive, both can send. One of them
holds the port; close it, and the other takes over. Nothing in the script refers to tabs.

## What it shows

- **The library from an import map.** `"serial-broker": "/serial-broker/serial-broker.js"` in the
  HTML, a
  bare `import` in the script - the same specifier a bundled application writes.
- **`configure({ workerUrl })` before `setup()`**, spelled out, because the worker script is the
  one thing about deploying this library that is easy to get wrong.
- **The connect button only where a click is needed.** It appears with `awaiting-permission` and
  disappears once the port is open. Later visits open the port with no click at all, because the
  browser remembers the choice.
- **Received text**, appended as it arrives. A chunk is an arbitrary piece of the byte stream, not
  a line; the device's own line endings make the lines.
- **Sending**, enabled only while the port is open.
- **Errors**, as `code` and the library's `remediation` sentence, in one line under the status.

## Running it

The page uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/minimal-js
npm install
npm start          # serves http://localhost:8159/
```

| Command             | What it does                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm start`         | `serve.mjs`: `index.html` at `/`, and `node_modules/serial-broker/dist/` at `/serial-broker/`. `PORT` overrides the port. |
| `npm run typecheck` | Type-checks the page's script against the library's types - see [Design decisions](#design-decisions).                    |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. Without a device you still see the page: the status is
`awaiting-permission`, and _Connect…_ opens the browser's port picker. A USB-serial adapter with
its TX and RX pins bridged echoes every line you send.

The smoke test runs the page against the Web Serial stand-in instead of a device, from the
repository root:

```sh
npm run test:examples -- examples/minimal-js/smoke.spec.ts
```

## Taking it into your own page

Copy the `<script type="module">` block out of `index.html`, and with it the import map. Then:

1. **Get the library files.** `npm install serial-broker`, and copy `serial-broker.js`,
   `serial-broker.worker.js` and their `.map` files out of `node_modules/serial-broker/dist/` to
   your own web server, under one directory - this page uses `/serial-broker/`.
   [Deploying to a web server](../../docs/site/deploying.md) has the headers and the checklist.
2. **Keep the two URLs in step.** The import map says where the library is, and
   `configure({ workerUrl })` where the worker script is. Every tab must load the worker from the
   same URL, or the tabs get separate workers and never see each other.
3. **Name your device.** Replace `device: { any: true }` with its USB ids, and `baudRate` with the
   device's. Leaving `device` out instead takes the device from the port the user picks, and
   remembers it ([Configuration](../../docs/site/configuration.md#device)).
4. **Call `requestAccess()` first thing in a click handler**, with nothing awaited before it.
5. **Show `error.code` and `error.remediation`**, and branch on `code` - never on `message`.

With a bundler the two URLs go away: it resolves `serial-broker` and finds the worker script
itself.

## Stable element ids

| Element                        | Id            |
| ------------------------------ | ------------- |
| Status, the value as it is     | `status`      |
| Connect button (hidden mostly) | `connect`     |
| Error line (empty if none)     | `error`       |
| Received text                  | `received`    |
| Send form                      | `send-form`   |
| Send input                     | `send-input`  |
| Send button                    | `send-button` |

## Design decisions

**One file, and supporting files that hold no application logic.** `serve.mjs` serves the page and
the library, `scripts/extract-page-script.mjs` exists so the page can be type-checked, and
`smoke.spec.ts` drives it in a browser. None of them is part of the integration: delete all three
and `index.html` still works, served by any web server that can reach the library files.

**The page is type-checked, although it is HTML.** `npm run typecheck` copies the inline script
into `.typecheck/`, keeping its line numbers, and runs `tsc` with `allowJs` and `checkJs` over the
copy: the JSDoc annotations in the script are checked against the library's published `.d.ts`
files, so a misspelt option or event name fails the check the way it would in a TypeScript
application, and CI runs it. The alternative - an example that is one HTML file and therefore
checked by nothing - would have left the plainest integration the only unchecked one.

**`el(id)` is typed as an `HTMLInputElement`.** One helper, deliberately over-specific, so that
`value`, `disabled`, `hidden` and `textContent` all need no annotation at their call sites. Naming
each element with its own type would have been seven lines of casts in a page whose point is that
there is nothing to wade through.

**`device: { any: true }`.** The page cannot know the reader's device, and a first page should
connect to whatever the user picks. It also means the smoke test's loopback device needs no ids.

**No status table, no error box.** The page shows the status word, one error
line, the data and a send box. The documentation site shows the rest, under Examples.

**`<link rel="icon" href="data:,">`.** Without it the browser requests `/favicon.ico`, the server
answers 404, and the console shows an error that is not the page's. The smoke test fails on any
console warning or error, so the page stays quiet.

**The smoke test connects by clicking.** The stand-in's device is installed _not_ granted, so the
example's own connect path is what runs - `requestPort()`, the stand-in's as much as the
browser's, needs the transient activation of a real click, and that is the one step of the
integration a page has to get right.

**The root ESLint configuration ignores this folder**, as it does every example; `npm run
typecheck` is the gate here, and CI runs it. Prettier still formats the folder.

## Files

```
examples/minimal-js/
├── index.html                     THE EXAMPLE: markup, import map, one inline module script
├── example.json                   port 8159, start command, ready path - read by the root
├── serve.mjs                      the development server, a short Node script
├── scripts/extract-page-script.mjs  puts the inline script where tsc can read it
├── smoke.spec.ts                  Playwright: loads the page, connects, sends, sees the echo
├── tsconfig.json                  checkJs over the extracted script and the Node scripts
└── package.json                   "serial-broker": "file:../..", and nothing else
```
