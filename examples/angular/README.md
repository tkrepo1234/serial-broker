# serial-broker in an Angular application

An Angular application that talks to a serial device through [serial-broker](../../README.md),
and the reusable integration module it uses: [`src/app/serial-broker/`](src/app/serial-broker).
Copy that folder into your own Angular application and you have the library as an injectable
`SerialBrokerService` whose signals a template reads directly.

Angular 22, standalone components, signals, no zone.js, the Angular CLI. This is the integration,
with the screen left out:

```ts
// app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // Tabs coordinate through a SharedWorker, identified by the URL of its script. angular.json
    // copies the script into `serial-broker/`; this names it, before the first setup().
    provideSerialBroker({
      workerUrl: new URL('serial-broker/serial-broker.worker.js', document.baseURI),
    }),
    provideSerialBrokerConfiguration({
      name: 'Device',
      options: {
        device: { any: true }, // or { vendorId: 0x1a86, productId: 0x7523 } for one kind of device
        serial: { baudRate: 9600 },
        encoding: { decodeText: true },
      },
    }),
  ],
};
```

```ts
// any component
export class PanelComponent {
  protected readonly serial = inject(SerialBrokerService); // sets the configuration up
}
```

```angular-html
<span>{{ serial.status() }}</span>

@if (serial.status() === 'awaiting-permission') {
  <!-- The browser shows its port picker during a click and nowhere else. -->
  <button (click)="serial.connect()">Connect…</button>
}

@if (serial.lastError(); as error) {
  <p>{{ error.code }}: {{ error.message }} {{ error.remediation }}</p>
}

@for (line of serial.lines(); track line.id) {
  <div>{{ line.direction }} {{ line.text }}</div>
}
```

Open the application in two tabs: both show the same status, both receive, both can send. One of
them holds the port; close it, and the other takes over. Nothing in the service refers to tabs.

## What it shows

- **Every status, named and explained.** `idle`, `queued`, `awaiting-permission`, `connecting`,
  `open`, `reconnecting`, `failed` and `released` each have one sentence saying what the screen is
  waiting for. A status the application does not know is shown with its name, as a wait: the set
  may grow.
- **The connect button only where a click is needed.** It appears with `awaiting-permission` and
  is gone once the port is open. Later visits open the port with no click, because the browser
  remembers the choice.
- **Errors with code, message and remediation**, from events and from the service's own calls.
  A retryable error - one the library is already recovering from - is shown as a note, not as a
  problem, and a connection error is cleared when the port opens again. A `send()` error stays
  until it is dismissed: the port being open again says nothing about the command.
- **Traffic as lines.** Every line the device sent, and every line any tab sent to it, marked
  _out, other tab_ when another tab sent it. What arrived after the last line ending - a prompt,
  or a line still on its way - is shown as it is. The last 200 lines are kept, because a screen on
  a production line stays open for weeks.
- **Sending**, enabled only while the port is open, with CR LF appended.
- **Release, and starting again.** _Release in this tab_ gives the device up here; the other tabs
  keep it. _Start again_ appears after `released` and `failed`, and sets the configuration up anew.
- **Nothing on the console.** The library logs nothing unless given a logger, and the application
  does not either; the smoke test fails on any console warning or error, and on any failed request.

## Running it

Angular 22 needs Node.js `^22.22.3`, `^24.15.0` or `>=26`, a narrower range than the repository
root's; the Angular CLI refuses to start on any other version. `package.json` declares it in
`engines`.

The application uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/angular
npm install
npm start          # serves http://localhost:8158/
```

| Command             | What it does                                                                       |
| ------------------- | ---------------------------------------------------------------------------------- |
| `npm start`         | `ng serve`: the Angular CLI's development server at <http://localhost:8158/>.      |
| `npm run typecheck` | `ngc -p tsconfig.app.json`: the TypeScript sources and the templates, no output.   |
| `npm run build`     | `ng build`: a production build in `dist/angular/browser/`, worker script included. |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. Without a device you still see the whole application: the status is
`awaiting-permission`, and _Connect…_ opens the browser's port picker. A USB-serial adapter with
its TX and RX pins bridged echoes every line you send.

Without any hardware, open <http://localhost:8158/?stand-in>: the development server then installs
the Web Serial stand-in from the repository's browser tests, a granted loopback adapter that echoes
whatever is sent. The production build leaves the stand-in out.

### The smoke test

```sh
# in the repository root, after `npm run build` there and `npm install` here
npm run test:examples -- examples/angular/smoke.spec.ts
```

[`smoke.spec.ts`](smoke.spec.ts) runs through the root's Playwright configuration, which starts
`npm start` on port 8158 first, in the installed Edge with the stand-in installed before the page
loads. The first test starts with a device that is not granted: it sees `awaiting-permission`,
clicks _Connect…_, sees `open`, sends `PING` and sees it listed as sent by this tab and echoed back
as received. The second starts with a granted device, sees `open` with no click, unplugs the device
and sees `reconnecting` with the `DEVICE_DISCONNECTED` note, plugs it in and sees `open` with the
note gone, releases, starts again and sends once more.

## Taking it into your own application

1. **Install the library:** `npm install serial-broker`.
2. **Copy [`src/app/serial-broker/`](src/app/serial-broker)** into your application. Four files,
   no dependencies beyond `@angular/core` and `serial-broker`.
3. **Serve the worker script from your origin.** Add it to the `assets` of the build target in
   `angular.json`:

   ```json
   {
     "glob": "serial-broker.worker.js{,.map}",
     "input": "node_modules/serial-broker/dist",
     "output": "serial-broker"
   }
   ```

   `ng serve` then serves it at `/serial-broker/serial-broker.worker.js`, and `ng build` copies it
   there.

4. **Provide the library and your device** in `app.config.ts`, as above: `provideSerialBroker()`
   with the worker URL, then `provideSerialBrokerConfiguration()` with the name and options.
5. **Name your device.** Replace `device: { any: true }` with its USB ids, and `baudRate` with the
   device's. On Windows the ids are in Device Manager under _Hardware Ids_ (`VID_1A86&PID_7523`);
   the library's [debugging surface](../../docs/site/diagnostics.md#the-debugging-surface) reads
   them off the device. Leaving `device` out instead lets the port the user picks decide.
6. **Inject `SerialBrokerService`** where you show the device, and read its signals in the
   template.
7. **Show a connect button only for `awaiting-permission`**, and call `serial.connect()` straight
   from `(click)` - no `await` before it, in a handler of your own either.
8. **Show `code` and `remediation`** of `lastError()`, and branch on `code` where the application
   has to decide - never on `message`. `send()` rejects with the error as well, so code that sends
   commands can decide what `OWNER_LOST_DURING_WRITE` means for each of them.

A second device is a second configuration: provide `provideSerialBrokerConfiguration()` in the
`providers` of the component that shows it, and that component and its children get a service of
their own. Give it a name of its own, too: `release()`, `restart()` and `releaseOnDestroy` act on
the name for the whole tab, so another service providing the same name loses the device with it.

### What the service offers

| Member              | What it is                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `status`            | `Signal<SerialBrokerStatus>`: the library's status, unchanged. Treat the set of values as growing. |
| `lastError`         | `Signal<SerialErrorInfo \| null>`: `code`, `message`, `remediation`, `retryable`, `timestamp`.     |
| `lines`             | `Signal<readonly SerialLine[]>`: `id`, `direction`, `text`, `local`, `timestamp`; oldest first.    |
| `partialLine`       | `Signal<string>`: what the device sent after its last line ending.                                 |
| `name`              | The configuration name.                                                                            |
| `connect()`         | Shows the port picker. Call it from a click. Resolves `true` once a port is granted.               |
| `send(data)`        | Sends text or bytes; nothing is appended. Resolves once the browser took the bytes for the port.   |
| `release(options?)` | Stops using the configuration in this tab; the status ends at `released`.                          |
| `restart()`         | Releases the configuration if it is still set up, and sets it up again.                            |
| `clearLines()`      | Empties `lines` and `partialLine`. The device is not touched.                                      |
| `clearError()`      | Clears `lastError`.                                                                                |

`provideSerialBrokerConfiguration()` also takes `maxLines` (200), `maxLineLength` (1024) and
`releaseOnDestroy` (`false`).

## What a developer needs to know

**The service sets the configuration up when it is created.** Injecting it is what starts the
connection, on every page load and in every tab - which is what the library expects. `setup()`
resolves once the configuration is registered, not once the port is open; `status` tells the
rest.

**`connect()` needs a user gesture.** The browser shows its port picker only during the transient
activation of a click, and any `await` before `requestAccess()` consumes it. `connect()` calls it
first and hands back the promise; call `connect()` from `(click)` the same way.

**The worker script must come from your origin, under one URL.** A `SharedWorker` is identified by
the URL of its script. Tabs that load it from different URLs get different workers and share
nothing. Where the script cannot be loaded at all, serial-broker falls back to a
`BroadcastChannel` and keeps working.

**One tab holds the port; no tab can tell which.** Every tab sets the same configuration up,
receives the same events and can send. Do not write UI that claims "this tab owns the device".

**An echo can be listed before the line that caused it.** `onSend` reports a write once the browser
took the bytes for the port, and a loopback or a fast device may answer before that report arrives.
With the stand-in, `STATUS?` sent shows up as `in` first and `out` second, in the same millisecond.
Read `lines` as what each side reported, not as a strict transcript of the wire.

**`failed` is not the end.** After `RECONNECT_EXHAUSTED` the configuration comes back by itself
when the device is plugged in again - with the default `connection.autoReconnect: true`; with
`false`, nothing is retried until `setup()` is called again. _Start again_ only tries sooner. After
`CONFIGURATION_CONFLICT` a tab stays `failed` until it is released and set up again, which is what
_Start again_ does. A failed configuration is usually still set up, and `setup()` with the same
options starts it again from any tab, so `restart()` releases first only after that conflict.

**Framing is the device's.** The library delivers `onReceive` events, not messages: an answer
usually arrives as one, but event boundaries carry no meaning. The service ends a line at CR, LF or
CR LF, splits a line longer than `maxLineLength`, and without `encoding.decodeText` lists every
event as a line of hexadecimal. A device with STX/ETX frames or length-prefixed messages
needs its own assembly in place of `#receive()`.

## Stable element ids

| Element                                  | Id                  |
| ---------------------------------------- | ------------------- |
| Status, the raw value                    | `status`            |
| Status hint, one sentence                | `status-hint`       |
| Connect (in `awaiting-permission`)       | `connect`           |
| Release in this tab                      | `release`           |
| Start again (after `released`, `failed`) | `restart`           |
| Open a second tab                        | `open-second-tab`   |
| Error box (absent if none)               | `error`             |
| Error code                               | `error-code`        |
| Error message                            | `error-message`     |
| Error remediation                        | `error-remediation` |
| "recovering by itself" note              | `error-recovering`  |
| Dismiss the error                        | `dismiss-error`     |
| Received and sent lines                  | `received`          |
| Clear the lines                          | `clear-lines`       |
| Send form                                | `send-form`         |
| Send input                               | `send-input`        |
| Send button                              | `send-button`       |

`#status` carries the value in `data-status` and `#error` carries `data-retryable`, for styling.
Each line in `#received` carries `data-direction` (`in`, `out`, or `partial` for the unterminated
tail) and `data-local`. Elements inside an `@if` are not hidden but absent while the condition is
false, so a test expects `toHaveCount(0)` rather than `toBeHidden()`.

## Design decisions

**Zoneless.** The application provides `provideZonelessChangeDetection()` and does not load
zone.js. Everything the screen shows comes from signals, and setting a signal that a template reads
schedules change detection by itself - also when the library calls back from a message of another
tab or from the worker, where zone.js would have had to patch `MessagePort` and
`BroadcastChannel` to notice. Zoneless is the default of a new Angular application; the provider
is spelled out anyway, so the decision is visible where it is made. The service does not depend
on it: in an application that still runs zone.js, the signals work the same.

**The worker script is copied by `angular.json`, and named with `configure({ workerUrl })`.**
Angular's application builder does not turn the library's own
`new URL('./serial-broker.worker.js', import.meta.url)` into an emitted file, so the script has to
come from somewhere the builder serves. An `assets` entry does that for `ng serve` and `ng build`
alike, with no copy script and no generated folder in the sources. The URL is resolved against
`document.baseURI`, so a build deployed with `--base-href /line-3/` still finds it, and every tab
of that deployment computes the same absolute URL.

**`provideSerialBroker()` is an application initializer.** `SerialBroker.configure()` has to run
before the first `setup()`, and the service runs `setup()` as soon as it is created. An initializer
runs before the root component, and therefore before anything the component injects.

**One service per configuration, provided rather than `providedIn: 'root'`.** The service needs a
name and options, and a device panel usually needs one of each. `provideSerialBrokerConfiguration()`
puts both in one call, and works in a component's `providers` as well as in the application's - the
way to a second device, without a registry of names inside the service.

**The service starts in its constructor.** Setting the configuration up on every page load is what
the library expects, and an explicit `start()` would be one more thing a component can forget.
Injecting the service is the decision to use the device.

**Failures go into `lastError`; `send()` rejects as well.** A template has nowhere to put a
rejected promise, so every failure - from an event, from `connect()`, from `release()` - lands in
`lastError`. `send()` also rejects, because code that sends commands has decisions to make that a
screen does not, above all for `OWNER_LOST_DURING_WRITE`. `connect()` resolves `false` instead,
because the only thing a click handler does with it is nothing.

**`lastError` is cleared when the port opens, except for a `send()` error.** The minimal example
clears its error box on `open`; doing it in the service means every screen agrees on it. The codes
of a write - `OWNER_LOST_DURING_WRITE`, `WRITE_FAILED`, `WRITE_TIMEOUT`, `WRITE_QUEUE_FULL` - are
kept: when the tab holding the port closes during a write, another tab takes over within moments,
and clearing on `open` would hide the one error that needs a decision before the command is sent
again. The set is chosen by code rather than by where the error came from, so an `onError` event
for the same write cannot clear it. A dismiss button calls `clearError()` for the rest.

**Lines are assembled in the service.** A received event is an arbitrary piece of the byte stream,
and every screen wants lines. A `\r` at the end of an event is held back, so a `\r\n` split across
two events is one line ending and not two; the unterminated tail is offered as `partialLine`, so a prompt
without a line ending is not invisible. Each line has an increasing `id` for `track`, because the
list slides once it is full and an index would re-render every row.

**Long lines are split, binary events are lines of their own.** A barcode scanner with no suffix
never sends a line ending, and a screen stays open for weeks: without a limit the tail would grow
for as long, and re-render in full with every event. At `maxLineLength` (1024 characters, well
above a text line and small enough to render) the tail becomes a line. Without text decoding there
is no line ending to look for at all - hexadecimal contains none - so each event is listed as it
arrived.

**Operations run one after another, destroying included.** `release()` and `restart()` go through
one queue inside the service, so that a second click on _Start again_ cannot release the
configuration the first one is setting up. The release of `releaseOnDestroy` goes through the same
queue, and a setup still waiting in it is skipped once the service is destroyed: a component closed
while _Start again_ or its first setup is under way would otherwise set the configuration up after
its own release, and hold the device with no screen.

**Send is disabled unless the port is open; Release and Start again replace each other.** The
library accepts a write in any status and waits up to `connection.writeTimeoutMs`; next to a status
that says the port is not open, a disabled button says the same thing sooner. Release is offered
while the configuration is in use, _Start again_ once it is not - never both.

**`remember: false`.** The application sets the configuration up on every load itself, so remembering
it for `SerialBroker.restore()` would add nothing and would leave an entry in `localStorage`
behind.

**`npm run typecheck` is `ngc -p tsconfig.app.json`, not `tsc` and not `ng build`.** `tsc` does not
see templates, and a binding to a method that does not exist would pass it. `ng build` checks them
but writes a bundle. `ngc`, the Angular compiler behind the build, type-checks the TypeScript and
the templates (`strictTemplates`) and, with `noEmit`, writes nothing.

**Component files keep the `.component` suffix.** The Angular style guide dropped it, but the
repository's Prettier, which formats every example, reads an `.html` file as an Angular template
only when it is named `*.component.html`; a plain `app.html` has its `@if` blocks flattened.

**The stand-in is swapped in with `fileReplacements`.** `src/stand-in.ts` does nothing;
`angular.json` replaces it with `src/stand-in.development.ts` in the development configuration,
which installs the repository's stand-in for `?stand-in`. The production build never sees the test
code, and an application of your own deletes both files and one line in `main.ts`.

**`"analytics": false` in `angular.json`.** The Angular CLI asks once whether to share usage data.
The root's test runner starts `npm start` with no terminal to answer in, and the answer should not
depend on the machine the example runs on.

**`<link rel="icon" href="data:,">`**, and no favicon file. Without it the browser requests
`/favicon.ico`, the development server answers 404, and the smoke test, which fails on any failed
request, fails for a reason that is not the application's.

**The root ESLint configuration ignores this folder**, as it does every example; `npm run
typecheck` is the gate here, and CI runs it. Prettier still formats the folder, and the root
type-checks `smoke.spec.ts`.

## Files

```
examples/angular/
├── example.json                  port 8158, start command, ready path - read by the root's test runner
├── smoke.spec.ts                 Playwright: connect, send, echo; unplug, plug, release, start again
├── angular.json                  the CLI workspace: worker script as an asset, stand-in replacement
├── tsconfig.json                 strict TypeScript and strict templates
├── tsconfig.app.json             what ngc and the builder compile
├── package.json                  Angular 22, "serial-broker": "file:../.."
└── src/
    ├── index.html
    ├── main.ts                   bootstraps the application
    ├── styles.css                status colours by data-status
    ├── stand-in.ts               production: nothing
    ├── stand-in.development.ts   development: the stand-in for ?stand-in
    └── app/
        ├── app.config.ts         zoneless, the worker URL, the configuration
        ├── app.component.ts      the screen: one hint per status, send, open a second tab
        ├── app.component.html
        └── serial-broker/        THE REUSABLE MODULE
            ├── index.ts
            ├── serial-broker.providers.ts      provideSerialBroker(), provideSerialBrokerConfiguration()
            ├── serial-broker.configuration.ts  the configuration type and its injection token
            └── serial-broker.service.ts        SerialBrokerService: signals and methods
```
