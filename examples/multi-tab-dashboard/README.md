# A multi-tab dashboard on one device

A runnable dashboard that uses one serial device from every tab of its origin through
[serial-broker](../../README.md): Vite, TypeScript, plain DOM, no framework. Open it twice and
both tabs show the same status, receive the same lines and can both send - while one of them,
which neither can tell, holds the port.

It is written as small modules that lift into an application one at a time:
[`src/device.ts`](src/device.ts) is the configuration and its lifecycle, [`src/status.ts`](src/status.ts)
names every status, [`src/permission.ts`](src/permission.ts) is the one user gesture,
[`src/error-strip.ts`](src/error-strip.ts) shows every failure with its code and remediation, and
[`src/traffic.ts`](src/traffic.ts) is the received list and the send field. Nothing in them knows
about the rest of the page.

## What it shows

- **Every status, named.** `idle`, `queued`, `awaiting-permission`, `connecting`, `open`,
  `reconnecting`, `failed` and `released` each have a label, a colour and a sentence that says
  what the user can do. The table is typed as a `Record` over the status union, so a status a
  later version adds is a compile error rather than a blank; an unknown value at run time is
  shown as it is. A legend on the page lists them all and marks the current one.
- **Errors with code and remediation.** One error strip for every failure: a rejected call and
  every `onError` event, showing `code`, `message` and the `remediation` sentence the library
  ships. A retryable error - one serial-broker is already recovering from - is shown as
  information, not as a failure.
- **The permission flow.** _Choose device…_ appears only while the status is
  `awaiting-permission`, and calls `requestAccess()` synchronously from the click - the one place
  a browser needs a user gesture. A dismissed picker is a note, not an error.
- **Received lines, and who sent what.** Chunks are joined into lines; a partial line is shown
  until its ending arrives. Every write appears too, marked _this tab_ or _another tab_ - `onSend`
  fires in every tab, with `origin` saying whose write it was.
- **Remembering and restoring.** _Remember this device_ decides `persist`; on load, `restore()`
  brings a remembered configuration back before anything is set up. _Release in this tab_ stops
  this tab only; _Forget device_ also revokes the browser's permission.
- **What the other tabs see.** Each tab tells the others the status serial-broker gave it, over a
  `BroadcastChannel` of the application's own, and lists what it hears. They agree, because the
  status comes from the tab holding the port - and no tab can tell which that is.
- **Diagnostics, read-only.** A panel on `serial-broker/diagnostics`: every tab that answers, its
  role - _holds the port_ or _participant_ - its status, connection state, bytes and pending writes.
  Below it, the library's `warn` and `error` log records, so the console stays quiet.

## Running it

The application uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/multi-tab-dashboard
npm install
npm start          # serves http://localhost:8152/
```

| Command             | What it does                                                        |
| ------------------- | ------------------------------------------------------------------- |
| `npm start`         | Serves the application at <http://localhost:8152/>, with reloading. |
| `npm run typecheck` | `tsc --noEmit` over `src/`.                                         |
| `npm run build`     | A production build in `dist/`, for a web server of your own.        |
| `npm run preview`   | Serves that build on the same port.                                 |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. With a device attached, press _Choose device…_ once; the browser remembers
the choice. Without one, open <http://localhost:8152/?stand-in>: the repository's loopback stand-in
replaces Web Serial, and everything you send comes back. _Open another tab_ keeps that flag.

The smoke test does the same from the outside, in the installed Edge:

```sh
# in the repository root, after npm run build
npm run test:examples -- examples/multi-tab-dashboard/smoke.spec.ts
```

## Taking it into an application of your own

1. **Install the library**: `npm install serial-broker`.
2. **Copy the modules you want** from `src/`. `device.ts`, `status.ts`, `permission.ts`,
   `error-strip.ts` and `traffic.ts` depend on nothing but the library and `dom.ts`; `peers.ts`
   and `diagnostics-panel.ts` are the two panels a dashboard has and a device page does not.
   Leave `stand-in.ts` behind - it reaches into this repository's test support - and make
   `main.ts` a plain `import './app.js'`.
3. **Name the worker script.** With Vite:

   ```ts
   import workerUrl from 'serial-broker/worker?url';

   SerialBroker.configure({ workerUrl, logger });
   ```

   `?url` makes Vite serve the file from your origin - and, in a production build, copy it into
   `dist/assets/` under a hashed name. A `SharedWorker` is identified by its script URL, so every
   tab has to load it from the same URL of the same origin. The library's default resolves the
   worker next to its own entry point with `import.meta.url`, which does not survive bundling.
   With another bundler, copy `node_modules/serial-broker/dist/serial-broker.worker.js` into your
   static files and pass that path.

4. **Configure before the first call.** `configure()` is read when the library builds its
   internals, which the first `setup()` or `restore()` does. In `app.ts` it is the first thing
   that runs.
5. **Restore, then set up**, as `startDevice()` does: `restore()` brings back what an earlier
   visit remembered; when the configuration is not among the restored names, `setup()` creates
   it. Calling `setup()` on every load is fine - with equal options it is a no-op.
6. **Subscribe after every setup.** Listeners do not survive a release. `attach()` in `app.ts`
   subscribes every panel and is called again after _Set up again_ and _Try again_.
7. **Ask for permission from a click, and from nothing else.** Show the button while the status is
   `awaiting-permission`; in the handler call `requestAccess()` first, with no `await` before it.
8. **Show the remediation.** Every `SerialBrokerError` carries one, written for the code. Branch
   on `code` if you must branch; never on `message`.

## What a developer needs to know

**Only the tab holding the port can ask for permission.** Every tab shows `awaiting-permission`,
and every tab shows the button, but `requestAccess()` in a tab that does not hold the port rejects
with `PERMISSION_REQUIRED` - the library cannot open a port another tab chose. The hint under the
status says so, and the error strip shows the remediation. With a device already granted, the
question does not arise: `setup()` opens it with no prompt in whichever tab holds the port.

**Which tab holds the port is invisible to the application, on purpose.** Nothing in the main
entry point says it, and no panel of this page claims "this tab owns the device". The diagnostics
entry point says it - to an operator, to be looked at, never to branch on.

**A release in one tab is a release in one tab.** The others keep the device, and if the releasing
tab held the port, another takes it over. What is remembered belongs to the origin: `release()`
forgets the stored configuration only when no other tab still runs it with `persist: true`.

**Changing `persist` means setting up again.** A repeated `setup()` with only `persist` changed is
a no-op - the options count as equivalent - so the checkbox releases and sets up again. The status
passes through `released` and comes back; the other tabs do not notice.

**Statuses, and what this page does with each:**

| Status                | What it means                                | What the page does                              |
| --------------------- | -------------------------------------------- | ----------------------------------------------- |
| `idle`                | Registered, not connecting yet.              | Shows it; it lasts milliseconds.                |
| `queued`              | `maxTabs` other tabs hold the configuration. | Explains the wait; nothing to press.            |
| `awaiting-permission` | No granted port matches the device.          | Shows _Choose device…_ - the one gesture.       |
| `connecting`          | Opening the port.                            | Busy colour; _Send_ is enabled, writes wait.    |
| `open`                | Connected.                                   | _Send_ enabled.                                 |
| `reconnecting`        | Lost, coming back on its own.                | Busy colour, no error.                          |
| `failed`              | Gave up, or a `maxTabs` conflict.            | Error strip has the reason; offers _Try again_. |
| `released`            | Given up in this tab.                        | Offers _Set up again_; _Send_ disabled.         |

**Errors reach the page two ways.** A call that fails rejects, and the handler that made the call
shows it - _While sending_, _While releasing_. Everything else arrives through `onError`, shown as
_Reported by the library_, or _Reported while recovering_ when `isRetryable` is set.

**The library logs nothing on its own.** The page passes a logger that keeps `warn` and `error`
records on the page: a transport fallback (`environment.transport-fallback`), a tab on another
protocol version, a malformed message. An application forwards them to its own logging instead.

## Design decisions

**Vite, because it is what most plain-TypeScript applications use.** It serves `src/main.ts` as
is, resolves the worker script with `?url`, and its production build is one command. Nothing else
in the example depends on it: the modules import only the library and each other.

**Plain DOM, no framework.** The framework examples show how each framework wraps the library;
this one shows the library itself. Every module takes the elements it works on as an argument
(`createTrafficPanel(elements, strip)`), so the same code fits a template of any framework.

**One configuration, `device: { any: true }`.** The example should run with whatever adapter a
reader has, so it accepts any granted port. A configuration that names its device by USB ids -
the comment in `device.ts` shows one - pre-filters the port picker and tells two granted ports
apart; the two configurations at once are in the OpenUI5 example.

**The status table is typed over the union.** `Record<SerialBrokerStatus, StatusPresentation>`
makes "every state named" a property the compiler checks, not a promise in a README. `present()`
still falls through for a value it does not know, because the library documents the union as
extensible.

**Retryable errors are information.** The library sets `isRetryable` when it is already
recovering; showing that as a failure would make an operator act on something that is being
handled. The strip switches to the information colour and appends a sentence saying so.

**A tab's other tabs are found by the application, not by the library.** The main entry point
deliberately says nothing about other tabs. A `BroadcastChannel` of the application's own, an id
per page load, a label per tab in `sessionStorage` and a ping every five seconds are all it takes.

**Liveness counts unanswered pings; it does not measure silence.** A browser runs the timers of a
hidden tab late - Chromium, after five minutes hidden, once a minute - but delivers messages at
once. A heartbeat on a timer would make every long-hidden tab, the normal state of a dashboard's
other tabs, vanish from the lists and flicker back; a ping is answered promptly however long the
tab has been hidden. A tab that left three pings in a row unanswered is taken off the list: a tab
that crashed within about twenty seconds, and a tab the browser froze as well - it comes back with
the first ping it answers. The library's message bus does the same, for the same reason.

**A label is not an identity.** The label survives a reload of its tab because it lives in
`sessionStorage` - which a browser copies into a tab it duplicates, or opens with an opener; the
_Open another tab_ link is `rel="noopener"` for that reason. Tabs are told apart by an id per page
load, and a tab that hears its own label from another id takes a new one. The ids decide which of
the two changes, so exactly one does.

**The diagnostics panel is read-only and collects on its own schedule.** A collection waits the
default 500 ms window, because nothing announces how many tabs exist. The panel collects on load,
on _Refresh_, and 400 ms after a status change - once per burst - rather than on a timer, so an
idle page sends nothing.

**Nothing is released on `pagehide`.** The browser lets go of the tab's locks as it unloads, and
another tab takes the port over; releasing first would only delay that. The panels that hold a
channel or a bus connection of their own are closed there.

**The worker URL is also what the diagnostics panel opens.** `openDiagnostics()` must name the
same broker script as the application, or it talks to a worker of its own and sees nobody;
`device.ts` exports the URL for that reason.

**`?stand-in` imports the repository's stand-in.** The smoke test installs it from the outside;
the flag exists so that the page can be looked at by hand without hardware. It reaches two
directories up into `test/browser/stand-in/`, which is why `stand-in.ts` is one file with one job
and the README says to leave it behind.

**`strictPort`.** Vite would otherwise move to the next free port without a word, and the README
and the smoke test both name 8152.

**The root ESLint configuration ignores this folder**, as it does every example; `npm run
typecheck` is the gate, and Prettier still formats it.

## Stable element ids

| Element                                                                              | id                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Status text (`data-status` = raw)                                                    | `status`                                                            |
| Status hint                                                                          | `status-hint`                                                       |
| Status legend table                                                                  | `status-legend`                                                     |
| Connect button (`awaiting-permission` only)                                          | `connect`                                                           |
| Note under the connect button                                                        | `connect-note`                                                      |
| Try again (`failed` only)                                                            | `retry`                                                             |
| Set up again (`released` only)                                                       | `setup-again`                                                       |
| Error strip                                                                          | `error-strip`                                                       |
| Error context, code, message, remediation                                            | `error-context`, `error-code`, `error-message`, `error-remediation` |
| Dismiss the error                                                                    | `error-dismiss`                                                     |
| Remember this device                                                                 | `remember-device`                                                   |
| Release in this tab                                                                  | `release`                                                           |
| Forget device                                                                        | `forget-device`                                                     |
| Open another tab                                                                     | `open-tab`                                                          |
| This tab's label                                                                     | `tab-label`                                                         |
| Received and sent lines (`li[data-kind]`: `received`, `sent-here`, `sent-elsewhere`) | `received`                                                          |
| Partial line                                                                         | `received-partial`                                                  |
| Clear the list                                                                       | `clear-received`                                                    |
| Send input, CR LF, send button                                                       | `send-input`, `append-newline`, `send-button`                       |
| Other tabs (`li[data-status]`)                                                       | `peers`                                                             |
| Diagnostics table (`tr[data-role]`)                                                  | `diagnostics`                                                       |
| Diagnostics refresh, summary                                                         | `diagnostics-refresh`, `diagnostics-summary`                        |
| Library log                                                                          | `library-log`                                                       |

## Files

```
examples/multi-tab-dashboard/
├── example.json            manifest the root reads: port 8152
├── smoke.spec.ts           Playwright, run through the root
├── vite.config.ts          port, strictPort, fs.allow for the linked library
├── tsconfig.json           type-check only
├── index.html              the structure, every id
└── src/
    ├── main.ts             ?stand-in, then the application
    ├── app.ts              wires the panels to the page and the configuration
    ├── device.ts           THE CONFIGURATION: worker URL, setup, restore, release, persist
    ├── status.ts           every status named; the legend
    ├── permission.ts       the one user gesture
    ├── error-strip.ts      code, message, remediation; onError
    ├── traffic.ts          lines received, lines sent by every tab, the send field
    ├── peers.ts            what the other tabs see, over a BroadcastChannel of its own
    ├── diagnostics-panel.ts serial-broker/diagnostics, read-only
    ├── log.ts              the library's warn and error records, on the page
    ├── stand-in.ts         the loopback stand-in for ?stand-in - leave it behind
    ├── dom.ts              byId and formatting
    └── styles.css
```
