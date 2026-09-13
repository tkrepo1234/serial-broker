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

If the worker cannot be loaded at all, serial-broker falls back to a `BroadcastChannel` and keeps
working. Behaviour is the same; the only difference is a little more message traffic between
tabs. See [The message bus](shared-ports.md#the-message-bus).

## Content security policy

A strict policy has to allow the worker script:

```text
worker-src 'self';
```

Without it, construction of the worker fails and the fallback transport is used — which works,
but is probably not what you intended. The library log records the fallback at `warn` level.

## Checking support at run time

```ts
import { isSupported } from 'serial-broker';

if (!isSupported()) {
  // Web Serial or Web Locks is missing, or this is not a secure context.
  // Hide the device feature, or explain why it is unavailable.
}
```

`isSupported()` can be called without touching anything else in the library, so it is safe in a
browser that has no Web Serial at all, and during server-side rendering.

[shared-worker]: https://developer.mozilla.org/en-US/docs/Web/API/SharedWorker
