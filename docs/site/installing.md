# Installing

## From npm

```sh
npm install serial-broker
```

The package contains three things:

| Path                                    | What it is                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `serial-broker`                         | The library, as ES module and CommonJS, with type definitions.                   |
| `serial-broker/serial-broker.worker.js` | The script that coordinates tabs. It has to be served as a file of its own.      |
| `serial-broker/diagnostics`             | A read-only view of every tab, for operators. See [Diagnostics](diagnostics.md). |

It also ships a debugging surface under `dist/debug/`, as static files that nothing serves
unless you do. See [Diagnostics](diagnostics.md).

## The worker script

Tabs coordinate through a [`SharedWorker`][shared-worker]. A shared worker is identified by the
URL of its script, so the script must be a real file with **the same URL in every tab** — a
`Blob` URL, which differs per tab, would give each tab a worker of its own.

Bundlers that understand `new URL('./file', import.meta.url)` — Vite, webpack 5, Parcel 2,
Rollup with the right plugin — find and emit the script on their own. Nothing needs to be done.

If yours does not, or if your assets are served from a path the bundler does not know about,
copy `node_modules/serial-broker/dist/serial-broker.worker.js` to your static assets and say
where it is **before the first `setup()`**:

```ts
import { SerialBroker } from 'serial-broker';

SerialBroker.configure({ workerUrl: '/assets/serial-broker.worker.js' });
```

Where the browser has no `SharedWorker`, refuses to create one, or cannot load the script — because
it was not deployed, or is served from another path — serial-broker uses a `BroadcastChannel`
instead and keeps working; see [The message bus](shared-ports.md#the-message-bus). It logs
`environment.transport-fallback` at `warn` level. Check the log once after deploying: the fallback
works, but a missing script is usually a mistake.

### CommonJS

The CommonJS build, which `require('serial-broker')` loads, cannot find the script by itself:
CommonJS has no `import.meta.url` to resolve it against, and no bundler emits the script for it.
An application that loads this build **must** copy the script as described above and set
`workerUrl`, and pass the same URL to `openDiagnostics()`.

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
logged as `environment.transport-fallback` at `warn` level. That works, but it is probably not
what you intended.

## Checking support at run time

```ts
import { isSupported } from 'serial-broker';

if (!isSupported()) {
  // Web Serial or Web Locks is missing (browsers offer neither outside a secure context),
  // or there is neither a SharedWorker nor a BroadcastChannel.
  // Hide the device feature, or explain why it is unavailable.
}
```

Either message bus is enough. Without a `BroadcastChannel`, a tab cannot notice tabs on another
version of serial-broker, and has nothing to fall back to when the worker script does not load.

`isSupported()` can be called without touching anything else in the library, so it is safe in a
browser that has no Web Serial at all, and during server-side rendering.

[shared-worker]: https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker
