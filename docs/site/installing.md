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

| Import path                             | What it is                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `serial-broker`                         | The library, as ES module and CommonJS, with type definitions.                   |
| `serial-broker/worker`                  | The script that coordinates tabs. It has to be served as a file of its own.      |
| `serial-broker/serial-broker.worker.js` | The same script, under its file name.                                            |
| `serial-broker/diagnostics`             | A read-only view of every tab, for operators. See [Diagnostics](diagnostics.md). |
| `serial-broker/min`                     | The library as a minified ES module, with the same exports and types.            |
| `serial-broker/diagnostics/min`         | The diagnostics entry point, minified.                                           |

It also ships a debugging surface under `dist/debug/`, as static files that nothing serves unless
you do. See [The debugging surface](diagnostics.md#the-debugging-surface).

### TypeScript

The type definitions need the `DOM` library, which the TypeScript configuration of a browser
application includes anyway: `send()` takes a `BufferSource`, and a worker URL may be a `URL`. They
need no Web Serial types — an application does not have to install `@types/w3c-web-serial`, and one
that has them for its own code keeps whichever version it chose. The definitions check cleanly with
`skipLibCheck: false` under `bundler`, `node16` and `node10` module resolution.

### Minified build

`dist/index.min.js` and `dist/diagnostics.min.js` are the same code, minified, with source maps.
Each is one file that imports nothing else, for pages that load the library without a bundler — from
your own static files, with `<script type="module">` or an import map. A bundler minifies on its own,
so there the readable build is the better choice.

```html
<script type="module">
  import { SerialBroker } from '/assets/serial-broker/index.min.js';
</script>
```

Both builds use the same worker script, so tabs on the minified build and tabs on the readable build
coordinate — as long as the script is served at the same URL for both.

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

### CommonJS

The CommonJS build, which `require('serial-broker')` loads, cannot find the script by itself:
CommonJS has no `import.meta.url` to resolve it against, and no bundler emits the script for it. An
application that loads this build **must** copy the script as described above and set `workerUrl`,
and pass the same URL to `openDiagnostics()`.

Without `workerUrl`, the CommonJS build does not guess a location. It creates no `SharedWorker`:
with the default `transport: 'auto'` it uses a `BroadcastChannel` and logs
`environment.transport-fallback` with a `reason` that names `workerUrl`, and with
`transport: 'sharedworker'`, `setup()` fails with `BROKER_UNAVAILABLE`.

## Content security policy

A strict policy has to allow the worker script:

```text
worker-src 'self';
```

Without it, the browser blocks the worker, and serial-broker falls back to a `BroadcastChannel`,
logged as `environment.transport-fallback`. That works, but it is probably not what you intended.
The debugging surface brings a policy of its own; see
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
