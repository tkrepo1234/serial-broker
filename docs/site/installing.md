# Installing

## Requirements

**A browser that implements Web Serial.** Web Serial is part of Chromium, and serial-broker is
tested in Chromium and in Microsoft Edge. Firefox and Safari do not implement Web Serial.
`isSupported()`, [below](#checking-support-at-run-time), tells at run time.

**A secure context.** Browsers offer Web Serial and Web Locks only on pages served over HTTPS, or
from `localhost` during development.

**One origin.** Tabs share a port only with tabs of the same origin — scheme, host and port. Tabs of
different origins never see each other.

**A message bus.** A `SharedWorker`, or where there is none, a `BroadcastChannel`. Every browser
with Web Serial has both, but a sandboxed iframe without `allow-same-origin` or a strict privacy
setting can take them away.

**The worker script, served by the application.** See [The worker script](#the-worker-script).

## From npm

```sh
npm install serial-broker
```

The package contains:

| Import path                             | File in `dist/`                         | What it is                                                                       |
| --------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `serial-broker`                         | `serial-broker.js`, `serial-broker.cjs` | The library, as ES module and CommonJS, with type definitions.                   |
| `serial-broker/worker`                  | `serial-broker.worker.js`               | The script that coordinates tabs. It has to be served as a file of its own.      |
| `serial-broker/serial-broker.worker.js` | the same                                | The same script, under its file name.                                            |
| `serial-broker/diagnostics`             | `serial-broker.diagnostics.js`          | A read-only view of every tab, for operators. See [Diagnostics](diagnostics.md). |
| `serial-broker/min`                     | `serial-broker.min.js`                  | The library as a minified ES module, with the same exports and types.            |
| `serial-broker/diagnostics/min`         | `serial-broker.diagnostics.min.js`      | The diagnostics entry point, minified.                                           |
| `serial-broker/global`                  | `serial-broker.global.js`               | The library as a classic script, on the global `SerialBroker`. No modules.       |
| `serial-broker/diagnostics/global`      | `serial-broker.diagnostics.global.js`   | The diagnostics entry point as a classic script, on `SerialBrokerDiagnostics`.   |

Every published file is named after the package rather than after the file it was built from, so
that a file copied onto a web server says what it is ([ADR-0043][adr-0043]). Each build has a
source map beside it.

It also ships a debugging surface under `dist/debug/`, as static files that nothing serves unless
you do. See [The debugging surface](diagnostics.md#the-debugging-surface).

### TypeScript

The type definitions need the `DOM` library, which the TypeScript configuration of a browser
application includes anyway: `send()` takes a `BufferSource`, and a worker URL may be a `URL`. They
need no Web Serial types — an application does not have to install `@types/w3c-web-serial`, and one
that has them for its own code keeps whichever version it chose. The definitions check cleanly with
`skipLibCheck: false` under `bundler`, `node16` and `node10` module resolution.

### Minified build

`dist/serial-broker.min.js` and `dist/serial-broker.diagnostics.min.js` are the same code,
minified, with source maps. Each is one file that imports nothing else, for pages that load the
library without a bundler — from your own static files, with an import map or by URL. A bundler
minifies on its own, so there the readable build is the better choice.

Copy `serial-broker.min.js` and `serial-broker.worker.js` into one directory, and map the specifier
`serial-broker/min` — the package's own export for the minified build — to the library:

```html
<script type="importmap">
  { "imports": { "serial-broker/min": "/assets/serial-broker/serial-broker.min.js" } }
</script>
<script type="module" src="/assets/app.js"></script>
```

```js
// app.js
import { SerialBroker } from 'serial-broker/min';

SerialBroker.configure({
  workerUrl: new URL('serial-broker.worker.js', import.meta.resolve('serial-broker/min')),
});
```

The worker URL is derived from where the map puts the library, so moving the directory is one change
in the map. Code that imports `serial-broker` instead needs the map to name that specifier; any
specifier works as long as the script imports the one the map names. Without an import map, import
the file by its URL: `import { SerialBroker } from '/assets/serial-broker/serial-broker.min.js'`.
[Deploying to a web server](deploying.md) lists the files, the headers a strict policy needs for the
import map, and what to check afterwards.

### Classic script build

For a page that writes no modules at all — no `type="module"`, no import map, no bare specifier.
Copy `serial-broker.global.js` and `serial-broker.worker.js` into one directory and load the first
with a plain `<script src>`:

```html
<script src="/assets/serial-broker/serial-broker.global.js"></script>
<script>
  // Required, and before the first setup(): see below.
  SerialBroker.configure({ workerUrl: '/assets/serial-broker/serial-broker.worker.js' });

  SerialBroker.setup('Scale', { serial: { baudRate: 19200 }, encoding: { decodeText: true } });
  SerialBroker.subscribe('Scale', 'onReceive', (event) => {
    document.querySelector('#weight').textContent = event.text;
  });
</script>
```

The build leaves **one global, `SerialBroker`**. It is the same facade a module imports —
`setup()`, `subscribe()`, `send()`, `requestAccess()`, `release()`, `configure()` and the rest —
and it carries the rest of the package's surface as properties of itself, so one name is all a page
needs:

| On the global                        | What a module imports   |
| ------------------------------------ | ----------------------- |
| `SerialBroker.setup()` and the rest  | `SerialBroker`          |
| `SerialBroker.SerialBrokerError`     | `SerialBrokerError`     |
| `SerialBroker.isSerialBrokerError()` | `isSerialBrokerError`   |
| `SerialBroker.SerialBrokerErrorCode` | `SerialBrokerErrorCode` |
| `SerialBroker.SerialBrokerStatus`    | `SerialBrokerStatus`    |
| `SerialBroker.REMEDIATION`           | `REMEDIATION`           |
| `SerialBroker.isSupported()`         | `isSupported`           |
| `SerialBroker.PROTOCOL_VERSION`      | `PROTOCOL_VERSION`      |

`serial-broker.diagnostics.global.js` is the diagnostics entry point in the same form, on the
global `SerialBrokerDiagnostics`, carrying `openDiagnostics()`, `CONNECTION_STATES` and
`DEFAULT_COLLECT_WINDOW_MS`. Nothing else is left on the page.

**`configure({ workerUrl })` is required with this build, before the first `setup()`.** A classic
script has no `import.meta.url`, so the library cannot find `serial-broker.worker.js` next to
itself, and it does not guess: a URL guessed from the page's own address would differ between two
pages of one application, and each would get a `SharedWorker` of its own. Without `workerUrl` the
library falls back to a `BroadcastChannel` and logs `environment.transport-fallback` with a reason
that names `workerUrl`; with `transport: 'sharedworker'`, `setup()` fails with
`BROKER_UNAVAILABLE`.

The classic build is for a `<script src>` tag, not for a bundler: an application with a bundler
should import `serial-broker`. There are no type definitions for it, because a page that can write
`import type` can import the package instead.

Every build uses the same worker script, so tabs on the classic build, the minified build and the
readable build all coordinate — as long as the script is served at the same URL for all of them.

## The worker script

Tabs coordinate through a [`SharedWorker`][shared-worker]. A shared worker is identified by the URL
of its script, so the script must be a real file with **the same URL in every tab** — a `Blob` URL,
which differs per tab, would give each tab a worker of its own.

Name that URL **before the first `setup()`**. Bundlers that understand
`new URL('./file', import.meta.url)` — Vite, webpack 5, Parcel 2, Rollup with the right plugin — find
and emit the script without it, but not every toolchain does, and naming it puts the one URL every
tab has to share in one line. With Vite, import the URL:

```ts
import { SerialBroker } from 'serial-broker';
import workerUrl from 'serial-broker/worker?url';

SerialBroker.configure({ workerUrl });
```

With any other toolchain, copy `node_modules/serial-broker/dist/serial-broker.worker.js` to your
static assets — the Angular CLI does it with an entry in the `assets` of `angular.json` — and pass
its path:

```ts
SerialBroker.configure({ workerUrl: '/assets/serial-broker.worker.js' });
```

Where the browser has no `SharedWorker`, refuses to create one, or cannot load the script — because
it was not deployed, or is served from another path — serial-broker uses a `BroadcastChannel`
instead and keeps working; see [The message bus](shared-ports.md#the-message-bus). It logs
`environment.transport-fallback` at `warn` level. Check the log once after deploying: the fallback
works, but a missing script is usually a mistake. `transport: 'sharedworker'` turns it into an error
instead; see [`configure()`](configuration.md#configure).

After deploying a new release, serve its worker script under the URL the pages use; a copy left over
from an earlier release is reported as `PROTOCOL_VERSION_MISMATCH`.

### CommonJS and the classic script build

The CommonJS build, which `require('serial-broker')` loads, cannot find the script by itself:
CommonJS has no `import.meta.url` to resolve it against, and no bundler emits the script for it.
The classic script build has the same gap, for the same reason. An application that loads either
one **must** copy the script as described above and set `workerUrl`, and pass the same URL to
`openDiagnostics()`.

Neither build guesses a location. Both create no `SharedWorker` without `workerUrl`: with the
default `transport: 'auto'` they use a `BroadcastChannel` and log
`environment.transport-fallback` with a `reason` that names `workerUrl`, and with
`transport: 'sharedworker'`, `setup()` fails with `BROKER_UNAVAILABLE`.

## Content security policy

A strict policy has to allow the worker script:

```text
worker-src 'self';
```

Without it, the browser blocks the worker, and serial-broker falls back to a `BroadcastChannel`,
logged as `environment.transport-fallback`. That works, but it is probably not what you intended.
serial-broker makes no network requests and loads nothing else, so it needs no `connect-src`. An
inline import map counts as an inline script under `script-src` and needs its hash — which is one
reason to prefer the [classic script build](#classic-script-build) where the policy is strict and
static: it is loaded from a `src` attribute, so `script-src 'self'` covers it and nothing has to be
hashed. The complete policy, the hash and the other headers are in
[Deploying to a web server](deploying.md). The debugging surface brings a policy of its own; see
[Whether to serve it](diagnostics.md#whether-to-serve-it).

## Checking support at run time

```ts
import { isSupported } from 'serial-broker';

if (!isSupported()) {
  // Web Serial or Web Locks is missing (browsers offer neither outside a secure context),
  // or there is neither a SharedWorker nor a BroadcastChannel.
  // Hide the device feature, or explain why it is unavailable.
}
```

`isSupported()` can be called without touching anything else in the library, so it is safe in a
browser that has no Web Serial at all, and during server-side rendering. It is also available as
`SerialBroker.isSupported()`.

[shared-worker]: https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker
[adr-0043]: https://github.com/tkrepo1234/serial-broker/blob/main/docs/adr/0043-a-classic-script-build-and-published-names.md
