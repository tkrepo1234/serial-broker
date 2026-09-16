# One tab at a time: serial-broker with `maxTabs: 1`

A runnable page for a device that one screen may drive at a time - a cutter here, but the same
holds for a dispenser, a label printer or a motor controller whose commands must not interleave.
Every tab of the origin sets the same configuration up with `maxTabs: 1`; the first one uses the
device, every other one shows `queued`, and takes over as soon as the tab in front of it releases
the device, closes or crashes.

Vite, TypeScript and plain DOM: no framework, so that what the library needs is visible in one
file, [`src/main.ts`](src/main.ts).

## What it shows

- **Every status, explained for the person at the screen.** The status word the library reports
  (`idle`, `queued`, `awaiting-permission`, `connecting`, `open`, `reconnecting`, `failed`,
  `released`) next to one sentence saying what it means and what, if anything, to do. A status
  the page does not know is shown as a wait with its name, not as a failure.
- **`queued` as a wait, not an error.** "Another tab is using the device. This tab receives
  nothing until then, and takes over as soon as that tab releases the device or closes." No
  button, no error panel, sending disabled.
- **The takeover.** Release the device in the first tab, or close it, and the second tab goes
  `queued` -> `idle` -> `connecting` -> `open` by itself. The event log on the page shows every
  transition.
- **A release button, and a way back.** _Release the device_ gives it up in this tab; _Use the
  device again_ sets the configuration up once more, which joins the queue behind whoever took
  over. After `failed` the same button sets the configuration up again, which tries again; a tab
  that withdrew over a different `maxTabs` is released first.
- **The connect button only where a click is needed.** _Choose device_ appears in
  `awaiting-permission` and nowhere else, and calls `requestAccess()` synchronously from the click.
- **Errors with code and remediation.** The `SerialBrokerError` code, its message and the
  remediation sentence the library ships for it. A retryable error - one the library is already
  recovering from - is marked as such.
- **Nothing on the console.** The library logs nothing unless given a logger, and the page does
  not either; the smoke test fails on any console warning or error.

## Running it

The page uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/exclusive
npm install
npm start          # serves http://localhost:8153/
```

| Command             | What it does                                                             |
| ------------------- | ------------------------------------------------------------------------ |
| `npm start`         | Vite's development server at <http://localhost:8153/>.                   |
| `npm run typecheck` | `tsc --noEmit` over `src/` and the smoke test.                           |
| `npm run build`     | A production build in `dist/`, worker script included, for a web server. |
| `npm run preview`   | Serves `dist/` on the same port, to check the build.                     |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. With a serial adapter plugged in, _Choose device_ opens the browser's port
picker; any port will do, and bridging its TX and RX pins turns it into the loopback the smoke test
uses. Without a device, open <http://localhost:8153/?stand-in>: the page then installs the Web
Serial stand-in from the repository's browser tests, a granted loopback adapter that echoes
whatever is sent. The flag works in the development server only; the production build leaves the
stand-in out.

To see the point of the example, click _Open a second tab_ - or open the URL again by hand. The
second tab shows `queued`. Click _Release the device_ in the first, or close it, and watch the
second one take over.

### The smoke test

```sh
# in the repository root
npm run test:examples -- examples/exclusive/smoke.spec.ts
```

[`smoke.spec.ts`](smoke.spec.ts) starts the page through the root's Playwright configuration, in
the installed Edge, with the stand-in installed before the page loads. It opens one tab and sees
it reach `open` without a click, sends a line and sees it echoed; opens a second tab and sees it
`queued`, releases in the first and sees the second take over and send, and the first join the
queue again with _Use the device again_; closes the first tab
instead of releasing, with the same outcome; and serves a page of the same origin that runs
"Cutter" with `maxTabs: 2`, sees the example withdraw with `CONFIGURATION_CONFLICT`, closes that
page and sees _Use the device again_ reach `open`.

## Taking it into your own application

1. **Install the library**: `npm install serial-broker`.
2. **Name the worker script.** A `SharedWorker` is identified by the URL of its script, and every
   tab has to load it from the same URL of your origin. With Vite that is one import:

   ```ts
   import workerUrl from 'serial-broker/worker?url';

   SerialBroker.configure({ workerUrl });
   ```

   Vite serves the file from `node_modules` while developing and copies it into `dist/assets/`
   in the build. With another bundler, copy `node_modules/serial-broker/dist/serial-broker.worker.js`
   next to your other static files and pass its URL. `configure()` has to run before the first
   `setup()`.

3. **Set the configuration up on every page load**, with `maxTabs: 1` and the same options in
   every tab:

   ```ts
   await SerialBroker.setup('Cutter', {
     device: { vendorId: 0x0403, productId: 0x6001 },
     serial: { baudRate: 9600 },
     encoding: { decodeText: true },
     maxTabs: 1,
   });
   ```

   `setup()` resolves once the configuration is registered, not once the port is open. If the
   browser already has permission for the device, the port opens with no click. Otherwise the
   status becomes `awaiting-permission`.

4. **Subscribe after `setup()`**, and again after every later `setup()`: the subscriptions belong
   to the configuration and end when it is released.

   ```ts
   SerialBroker.subscribe('Cutter', 'onStatusChange', (event) => render(event.status));
   SerialBroker.subscribe('Cutter', 'onReceive', (event) => show(event.text));
   SerialBroker.subscribe('Cutter', 'onError', (event) => showError(event.error));
   ```

5. **Render every status**, `queued` as a wait. The table in
   [`src/main.ts`](src/main.ts) (`EXPLANATION`) is a starting point; treat the set of values as
   growing and fall through to something neutral for one you do not know.

6. **Offer a connect button in `awaiting-permission` only**, and call `requestAccess()` first
   thing in its click handler - any `await` before it consumes the gesture, and the browser then
   shows no picker.

7. **Show errors with their remediation.** `event.error.code` is stable, `event.error.remediation`
   is one sentence written for that code, and `event.error.isRetryable` says the library is already
   dealing with it. A call that rejects - `send()`, `release()`, `requestAccess()` - carries the
   same fields.

8. **Offer release**, and set up again afterwards. `release('Cutter')` gives the device up in this
   tab only: the next tab in the queue takes over, and this tab's status ends at `released`.
   Calling `setup()` again joins the queue.

   A configuration that shows `failed` is still set up, and `setup()` with the same options starts
   it again, from any tab. So a "try again" button calls `setup()`. Only a tab that withdrew over a
   different `maxTabs` needs a release first:

   ```ts
   const { status, lastErrorCode } = SerialBroker.getStatus('Cutter');
   if (status === 'failed' && lastErrorCode === SerialBrokerErrorCode.CONFIGURATION_CONFLICT) {
     await SerialBroker.release('Cutter');
   }
   await SerialBroker.setup('Cutter', options);
   ```

9. **Say goodbye on `pagehide`**, optionally. `SerialBroker.dispose()` there closes the port and
   lets the place go before the browser tears the tab down, so the next tab takes over a little
   sooner. Without it the browser frees everything as the tab dies, and the next tab still takes
   over.

## What a developer needs to know

**Every tab must pass the same `maxTabs`.** A tab that finds the tab holding the port running a
different limit reports `CONFIGURATION_CONFLICT` and shows `failed` until it is released and set
up again with the same limit. The remediation sentence says so.

**A `failed` configuration is still set up, and `setup()` starts it again.** `setup()` with the
name and options of an existing configuration leaves a working or reconnecting one alone -
re-running the connection would interrupt a working port - and tries a failed one again, from
any tab. `useTheDevice()` in [`src/main.ts`](src/main.ts) relies on that. Two
`failed` cases end by themselves as well: one reached after `connection.maxAttempts` (this page
keeps the default, `Infinity`, so it never sees one) and one reached by an open failure that is not
retryable both resume when the device is plugged in again. A withdrawal after a conflict does
neither: the tab has left the bus, `setup()` does not bring it back, and only release and set up
do, which is what `useTheDevice()` does for a `failed` status with `CONFIGURATION_CONFLICT`.

**A queued tab receives nothing, and its writes wait.** A `send()` issued while `queued` waits
for a place up to `connection.writeTimeoutMs` (5 s by default) and then rejects with
`WRITE_TIMEOUT`. The page disables _Send_ meanwhile rather than let a write time out.

**With `maxTabs: 1`, the open tab is the one using the device.** In general the library keeps
which tab holds the port invisible, on purpose; with a limit of one the tab that is not queued is
the only tab using the configuration, so the page may say "this is the only tab using the device".
With a larger limit it may not.

**The status goes `queued` first, even in the first tab.** A configuration with a limit starts at
`queued` and moves to `idle` the moment it has a place, which in an empty queue is at once. A page
that logs transitions sees `queued -> idle -> connecting -> open` in the first tab as well.

**`released` is the configuration's last event.** By the time it is delivered,
`SerialBroker.exists()` answers `false`, and the subscriptions are gone with the configuration.

**Closing a tab takes a moment longer than releasing.** A tab that releases says goodbye and hands
its place on at once. A tab that is closed lets the browser free its Web Locks as it dies, which the
`pagehide` handler in this page shortens by calling `dispose()`; a tab that crashes has no handler,
and the browser still frees its locks - no timeout is involved.

## Stable element ids

| Element                              | Id                                                 |
| ------------------------------------ | -------------------------------------------------- |
| Status word, as the library reports  | `status`                                           |
| One sentence about the status        | `status-explanation`                               |
| Connect (in `awaiting-permission`)   | `connect`                                          |
| Release the device                   | `release`                                          |
| Use the device again                 | `setup`                                            |
| Open a second tab                    | `open-second-tab`                                  |
| Error panel                          | `error`                                            |
| Error code, message, remediation     | `error-code`, `error-message`, `error-remediation` |
| "recovering by itself" note          | `error-recovering`                                 |
| Dismiss the error                    | `dismiss-error`                                    |
| Send form, input and button          | `send-form`, `send-input`, `send-button`           |
| Received text                        | `received`                                         |
| Event log                            | `log`                                              |
| Shown when the browser lacks support | `unsupported`                                      |

The status element also carries the status in `data-status`, which the stylesheet colours by.

## Design decisions

**Vite with `?url` for the worker script, not a copy.** Vite resolves the package export
`serial-broker/worker` to a same-origin URL in both the development server and the build, so the
page needs no copy step and no configuration file. A `SharedWorker` needs one URL in every tab;
an import that Vite rewrites gives the same string to every tab of one build. Other bundlers get
the copy-and-configure route the openui5 example takes.

**`device: { any: true }`.** The example should run with whatever adapter is at hand, and the
stand-in's loopback device matches it too. An application names its device by USB ids; the
comment at the option says so. Leaving `device` out takes the device from the port the user picks
instead, and shares it with the other tabs.

**`remember: false`.** The page sets the configuration up on every load itself, so remembering it
would add nothing to what the page shows and would leave an entry in `localStorage` behind. An
application that lets the user configure devices keeps the default and calls `restore()`.

A release forgets nothing by itself, so _Release the device_ has nothing to clean up here either.
An application that does remember its configuration and wants it gone passes
`release('Cutter', { forget: true })`; the browser's permission goes with `forgetDevice: true`.

**The connect button, the release button and the set-up button are shown and hidden, not
disabled.** A disabled button suggests a state the user could reach; a hidden one says the step
does not apply. Send is the exception: it is disabled while a write would wait, because the input
next to it stays useful.

**_Use the device again_ stays in `failed`.** The button could be hidden while the configuration is
still set up, leaving _Release the device_ as the only way out and a second click for the way back.
It stays, because the person at the screen wants one thing - the device again - and whether that
takes one library call or two is the page's business. It is disabled while it runs, so that a
second click cannot release the configuration the first is setting up.

**A retryable error is information, not a failure.** `isRetryable` means the library is already
recovering, and the status shows the recovery. The panel stays red for the rest; a retryable one is
marked with a note and an amber border.

**The stand-in is imported behind `import.meta.env.DEV`.** The page can install the repository's
Web Serial stand-in itself when opened with `?stand-in`, which lets a reader see every state
without hardware. The import is dynamic and guarded, so Vite leaves it out of the production build;
an application of your own would drop the block.

**The smoke test fails on console noise.** Every page error, console error and console warning
of every tab is collected and expected to be empty. An empty `<link rel="icon">` keeps the
browser's request for `/favicon.ico`, and its 404, out of that list.

**No `vite.config.ts`.** The port is in the `start` script, the worker needs no plugin, and the
files outside the example (the linked library, the stand-in) are within what Vite serves by default
here. A configuration file would be twelve lines saying nothing.

## Files

```
examples/exclusive/
├── example.json        the manifest the root's test runner reads
├── index.html          the page, with the ids above
├── smoke.spec.ts       Playwright smoke test, run through the root
├── tsconfig.json       type-check only
└── src/
    ├── main.ts         THE INTEGRATION: configuration, calls, one render per status
    └── style.css       plain styling, status colours by data-status
```
