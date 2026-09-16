# serial-broker without a bundler

A static page that uses [serial-broker](../../README.md) with no build step: an import map points
`serial-broker/min` at the minified library, the worker script is served next to it, and a small
static server delivers both from the application's own origin. What you deploy is a folder of
files; what you read is one HTML file and one script.

This is the shape of many production-line front ends: a page on an industrial PC, served by
whatever web server the site already runs, maintained by people who would rather not own a
JavaScript toolchain. Everything the library needs from the host is visible here, with nothing
resolved by a bundler behind the scenes.

## What it shows

- **Loading the library from an import map.** `index.html` maps the bare specifier
  `serial-broker/min` to `/serial-broker/serial-broker.min.js`; `app.js` imports it like any module.
- **`configure({ workerUrl })`, explicitly.** The worker script is the second file the library
  needs, and a `SharedWorker` is identified by its URL - so the page names it, before `setup()`.
- **Every status, explained.** The status word as the library reports it, in the colour of its
  meaning, with one sentence saying what it means and what to do - `idle`, `queued`,
  `awaiting-permission`, `connecting`, `open`, `reconnecting`, `failed`, `released`, and a
  neutral line for a status a later version might add.
- **The connect button only where a gesture is needed.** It appears for `awaiting-permission` and
  for nothing else, and calls `requestAccess()` synchronously from the click.
- **Errors with code and remediation.** Every `SerialBrokerError` - from `onError`, from a refused
  write, from `setup()` - is shown with its `code`, its message and the `remediation` sentence
  the library ships. A retryable error is shown as _Recovering_ and clears itself once the
  connection is back.
- **Received data and sent data, from every tab.** What the device sends, decoded as UTF-8, and
  every write any tab made, with `origin` saying whether it was this tab.
- **Release, and set up again.** _Release in this tab_ gives the configuration up here only; the
  other tabs keep the device. _Set up again_ brings it back, and is also the retry after `failed`.
- **The library's log on the page.** Warnings and errors the library reports through its
  `logger` - the fallback to a `BroadcastChannel` when the worker script does not load, for one -
  appear in a section of the page, not on the console. The console stays empty.
- **A browser without Web Serial** gets a sentence saying so, from `isSupported()`, instead of a
  page that does nothing.
- **One port, every tab.** _Open a second tab_ opens the page again. Both show the same status,
  both receive, both can send; one of them holds the port, and when it closes the other takes
  over.

## Running it

The page uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/no-bundler
npm install
npm start          # serves http://localhost:8154/
```

| Command             | What it does                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`         | `serve.mjs`: `public/` at `/`, and `node_modules/serial-broker/dist/` at `/serial-broker/`. `PORT` overrides the port.                                                                                        |
| `npm run typecheck` | `tsc --noEmit` over the plain JavaScript, with `checkJs`, against the library's type definitions. See [Design decisions](#design-decisions).                                                                  |
| `npm run build`     | Copies the page into `dist/`, and four library files - `serial-broker.min.js`, `serial-broker.worker.js` and their `.map` files - into `dist/serial-broker/`: a folder any static web server serves as it is. |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. Without a device attached you still see the whole page: the status is
`awaiting-permission`, and _Choose device…_ opens the browser's port picker.

## Taking it into a page of your own

1. **Get the library files.** `npm install serial-broker` on a machine with npm, and copy four files
   from `node_modules/serial-broker/dist/` - the same four `npm run build` copies:
   - `serial-broker.min.js`, the library;
   - `serial-broker.worker.js`, the worker script;
   - `serial-broker.min.js.map` and `serial-broker.worker.js.map`, optional, for readable stack traces.

   With no npm at hand, download `serial-broker-<version>-browser.zip` from the release instead: it
   holds the same files, already in a `serial-broker/` folder.

   Put them on your own origin, under one directory: this example uses `/serial-broker/`.
   [Deploying to a web server](../../docs/site/deploying.md) has the headers - content security
   policy, MIME types, caching - and a checklist for after deploying.

2. **Map the import** in the HTML, before the first module script:

   ```html
   <script type="importmap">
     { "imports": { "serial-broker/min": "/serial-broker/serial-broker.min.js" } }
   </script>
   <script type="module" src="/app.js"></script>
   ```

   Any specifier works, as long as the script imports the same one. Without an import map, import
   the file by its URL instead: `import { SerialBroker } from '/serial-broker/serial-broker.min.js'`.

3. **Name the worker script, then set up** - in that order:

   ```js
   import { SerialBroker } from 'serial-broker/min';

   SerialBroker.configure({ workerUrl: '/serial-broker/serial-broker.worker.js' });
   await SerialBroker.setup('Scale', {
     device: { vendorId: 0x0403, productId: 0x6001 },
     serial: { baudRate: 19_200 },
     encoding: { decodeText: true },
   });
   ```

   Every tab must use the same worker URL, or the tabs get separate workers and never see each
   other. Serving the library under a sub-path (`https://host/scale/serial-broker/`) means both
   the import map and `workerUrl` change together. To keep the path in the import map alone, derive
   the worker URL from where the map puts the library:

   ```js
   SerialBroker.configure({
     workerUrl: new URL('serial-broker.worker.js', import.meta.resolve('serial-broker/min')),
   });
   ```

4. **Subscribe to the status.** A new listener is told the current status once, right after
   `subscribe()` returns, with `previousStatus` equal to `status`, so nothing is missed between
   `setup()` resolving and the listener being registered.

5. **Show the connect button for `awaiting-permission` only**, and call `requestAccess()` as the
   first thing in its click handler - no `await` before it.

6. **Show `error.code` and `error.remediation`**, from `onError` and from every rejected promise.
   Branch on `code`, never on `message`.

7. **Deploy the folder.** `npm run build` shows what that folder contains. A content security
   policy has to allow `worker-src 'self'`, and the inline import map needs its hash in
   `script-src`; see [Deploying to a web server](../../docs/site/deploying.md).

## What a developer needs to know

**`requestAccess()` needs a user gesture.** The browser shows its port picker only during the
transient activation of a click, and any `await` before the call consumes it. The library cannot
work around this - it is the one step it leaves to the page.

**The worker script must come from your origin, under one URL.** The ES module builds look for
`serial-broker.worker.js` next to their own script, so this page would find the file without
`configure()`; it names it anyway, so that the requirement is visible and a page that moves the
library later has one line to change. The classic script build has no choice: it cannot find the
file by itself, and `configure({ workerUrl })` is required there. Where the script cannot be loaded, serial-broker falls back
to a `BroadcastChannel` and keeps working, and logs `environment.transport-fallback` at `warn`
level - which this page shows in its _Library log_ section.

**One tab holds the port; no tab can tell which.** Every tab sets the same configuration up,
receives the same events and can send. Which tab does the work is deliberately invisible, and the
page says nothing that claims otherwise.

**Statuses, and what the page does for each:**

| Status                | What it means                                | What the page does                                                              |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- |
| `idle`                | Registered, not connecting yet.              | Shows it; it lasts milliseconds.                                                |
| `queued`              | `maxTabs` other tabs hold the configuration. | Explains the wait; it resolves by itself.                                       |
| `awaiting-permission` | No granted port matches the device.          | Shows _Choose device…_ - the one gesture.                                       |
| `connecting`          | Opening the port.                            | Enables sending; a write waits for the connection.                              |
| `open`                | Connected.                                   | Enables sending; clears a retryable error.                                      |
| `reconnecting`        | Lost, coming back on its own.                | Says so; sending stays enabled; the loss is shown as _Recovering_ until `open`. |
| `failed`              | Gave up, or a `maxTabs` conflict.            | Shows the error's remediation and _Set up again_.                               |
| `released`            | Given up in this tab.                        | Offers _Set up again_; the other tabs are unaffected.                           |

**Errors carry their own remediation.** `remediation` is written for the developer and specific to
the code; the page shows it next to the code. An operator needs a sentence of the application's
own. `isRetryable` means the library is already recovering - the page shows that as information,
headed _Recovering_, and removes it once the status is `open` again. That reading holds with
`connection.autoReconnect` on, the default: with it off, the same codes still carry
`isRetryable: true`, nothing recovers, and the status becomes `failed`, so watch the status instead.

## Stable element ids

| Element                           | Id                                                 |
| --------------------------------- | -------------------------------------------------- |
| Status word (`data-status` too)   | `status`                                           |
| Status explanation                | `status-hint`                                      |
| Connect (port picker)             | `connect`                                          |
| Set up again                      | `retry`                                            |
| Release in this tab               | `release`                                          |
| Error section                     | `error`                                            |
| Error code / message / what to do | `error-code`, `error-message`, `error-remediation` |
| Dismiss the error                 | `error-dismiss`                                    |
| Send form, input, line ending     | `send-form`, `send-input`, `line-ending`           |
| Send button                       | `send`                                             |
| Received text                     | `received`                                         |
| Clear received text               | `clear-received`                                   |
| Sent lines, from every tab        | `sent`                                             |
| Library log section and list      | `log-section`, `log`                               |
| Unsupported-browser notice        | `unsupported`, `unsupported-reason`                |
| Open a second tab                 | `open-second-tab`                                  |
| Configuration name                | `configuration-name`                               |
| Protocol version                  | `protocol-version`                                 |

`smoke.spec.ts` uses `status`, `connect`, `error`, `send-input`, `send`, `received`, `sent` and
`log-section`.

## Design decisions

**An import map, not a URL import.** `import { SerialBroker } from '/serial-broker/serial-broker.min.js'`
would work and save the map. The map keeps the script identical to what a bundled application
writes - a bare specifier - so that `app.js` can be moved into a bundler project unchanged, and
the one line that knows where the library lives is in the HTML next to the script tag.

**Modules, not the classic script build.** The package also ships
`serial-broker.global.js`, a classic script that puts the library on the global `SerialBroker`
with no module, no import map and no bare specifier
([Installing](../../docs/site/installing.md#classic-script-build)). It is the shorter way in for a
page that already writes `<script>` blocks, and the one to use where a strict content security
policy makes an inline import map awkward - an import map is an inline script and needs its hash;
a `<script src>` does not. This example stays on modules because its point is a page with **no
build step** rather than a page with **no modules**: `app.js` is written exactly as a bundled
application would write it, so the step from here to a toolchain is the import map and nothing
else. With the classic build the two differences are the load and the mandatory
`configure({ workerUrl })`; everything below about statuses, errors and tabs is the same.

**The library files are served from `node_modules`, not copied.** `serve.mjs` maps `/serial-broker/`
to `node_modules/serial-broker/dist/`, so a rebuild of the library is visible on reload with
nothing to copy. `npm run build` is where the copy happens, into a `dist/` folder that is the
deployment unit. The OpenUI5 example copies before serving instead, because UI5 Tooling serves a
fixed tree; here there is no tool in the way.

**A short Node server, not a package.** `serve` or `http-server` would do the same. A static
server is short enough to read, and an example that promises "no toolchain" should not
start by installing one. The server sends `cache-control: no-store`, so that a developer who
rebuilds the library sees the new build, not a cached mixture of two.

**`workerUrl` is configured although the default would find the file.** The readable and the
minified build both resolve the worker next to their own script, so
`/serial-broker/serial-broker.min.js`
already implies `/serial-broker/serial-broker.worker.js`. The example names it anyway: the
requirement that every tab loads the same worker URL is the one thing about deploying this library
that is easy to get wrong, and an explicit line is what a reader copies.

**Plain JavaScript with a real type check.** There is no TypeScript build - the browser runs
`app.js` as it is - but `npm run typecheck` still type-checks it: `tsc` with `allowJs` and
`checkJs`, JSDoc annotations in the script, and the library's published `.d.ts` files resolved
through the `serial-broker/min` export. A misspelt option or event name fails the check, the way it
would in a TypeScript application, and CI runs it. The alternative - a `typecheck` script that
prints "nothing to check" - would have left the plain-JavaScript integration the only untyped one.

**`device: { any: true }`.** The page is meant to work with whatever adapter is at hand. An
application names its device by USB ids, so that the picker is filtered and two granted devices
are never confused; the comment in `app.js` and step 3 above show the form. Leaving `device` out
lets the port the user picks decide, and the library remembers that device.

**Sending is enabled while `connecting` and `reconnecting`, not only while `open`.** A write
issued then is accepted and waits for the connection, up to `connection.writeTimeoutMs`. Disabling
the input would hide a capability the library has; a write that does time out is shown with its
code.

**Received text is capped at 64 KiB, the lists at 200 entries.** A page on a production line stays
open for a shift, and a `<pre>` that grows without bound is a memory leak with a scrollbar.

**No `?stand-in` query flag.** The smoke test installs the Web Serial stand-in from the test side,
and the stand-in is a TypeScript module; serving it from a page whose point is "no build step"
would have needed a transpiling route in the server. Run the example by hand with an adapter, or
with the loopback the manual test plan describes.

**The smoke test checks the worker, not only the echo.** Under `transport: 'auto'` a worker script
that fails to load is replaced by a `BroadcastChannel`, and the page connects, sends and receives
as before - so a test that stops at the echo passes with the worker not served at all. The test
therefore asks Chromium for its shared workers, the way `chrome://inspect/#workers` does, and
expects exactly one, from the configured URL; and it expects the _Library log_ section to stay
hidden, which the fallback's warning would have opened.

**The root ESLint configuration ignores this folder.** `app.js` reads `window` globals and uses
JSDoc types, which the root's type-aware rules for TypeScript sources have nothing to say about;
`npm run typecheck` is the gate here. Prettier formats the folder.

## Files

```
examples/no-bundler/
├── example.json          port, start command, ready path - read by the root's test runner
├── package.json          start, typecheck, build; serial-broker as a file: dependency
├── serve.mjs             the development server, a short Node script
├── scripts/build.mjs     assembles dist/ for a static web server
├── tsconfig.json         checkJs over public/ and the scripts
├── smoke.spec.ts         the Playwright smoke test, run through the root
└── public/
    ├── index.html        the import map, the page, its styles
    └── app.js            configure, setup, every status, every error
```
