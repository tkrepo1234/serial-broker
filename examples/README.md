# Example applications

Runnable applications that use serial-broker the way an application does: through the published
entry points only, never through `src/`. Each one lives in its own directory with its own
`package.json`, dependencies and toolchain, deliberately kept out of the root `package.json`.

| Directory | Shows |
| ---------------------- | -------------------------------------------------------------------------------------- |
| `minimal/` | One page: connect, print what arrives, send text. |

| `multi-tab-dashboard/` | Several tabs on one device: every status, errors, permission, remembering, diagnostics. |
| `exclusive/` | `maxTabs: 1`: one tab at a time, `queued` shown as a wait, the takeover, a release. |
| `no-bundler/` | Static HTML: `serial-broker/min` from an import map, a static server, no build step. |
| `openui5/` | SAP OpenUI5: a reusable integration module (`JSONModel`) and an application using it. |
| `react/` | React: a `useSerialBroker` hook. |
| `vue/` | Vue 3: a composable. |
| `svelte/` | Svelte 5: a store. |
| `angular/` | Angular: a service with signals. |

## The contract every example keeps

So that one command builds, type-checks and smoke-tests all of them, every example directory
provides:

- **`package.json`** with `"private": true`, a `package-lock.json`, and these scripts:
  - `npm start` - serves the application on the port named in `example.json`, until stopped;
  - `npm run typecheck` - type-checks it (`tsc --noEmit` or the framework's equivalent), which CI
    runs for every example;
  - `npm run build` - a production build, where the toolchain has one.
- **`example.json`** - the manifest the root reads:

  ```json
  {
    "name": "minimal",
    "port": 8151,
    "start": "npm start",
    "readyPath": "/",
    "summary": "One page that connects, prints received lines and sends text."
  }
  ```

  Ports are fixed and unique per example, from 8150 upwards; `readyPath` is a path that answers
  with 200 once the server is up.

- **The library as a dependency** with `"serial-broker": "file:../.."`, so an example exercises the
  working tree. The root has to be built first (`npm run build` at the repository root); the
  example's own `preinstall` or `prestart` script must not build the root.
- **The worker script served from the application's own origin.** How each toolchain gets
  `serial-broker.worker.js` there - copied, served from `node_modules`, resolved by the bundler
  from `new URL(..., import.meta.url)` - is the example's decision, documented in its README, and
  `SerialBroker.configure({ workerUrl })` names it where the bundler cannot.
- **A `README.md`** that says what the example shows, how to start it, how to take its integration
  into an application of your own, and which design decisions it made and why.
- **Stable element ids** for what a test drives, listed in the README: at least the status text, the
  connect button, the received-data area, the send input and the send button.
- **`smoke.spec.ts`** next to `example.json`: a Playwright test that loads the page with the Web
  Serial stand-in installed (`test/browser/stand-in/`), connects, sends a line and sees it come back
  from the loopback device. It imports the stand-in and its helpers with relative paths
  (`../../test/browser/...`), uses the ids above, and passes when run through the root:

  ```sh
  npm run build            # once, at the repository root
  npm run test:examples    # every example's smoke test, in the installed Edge
  npm run test:examples -- examples/minimal/smoke.spec.ts
  ```

  The root configuration (`playwright.examples.config.ts`) reads every `example.json`, starts each
  example with its `start` command on its port, and runs the `smoke.spec.ts` files. CI does the same
  with Chromium, after `npm ci` in every example directory.

  Unlike the rest of the example, `smoke.spec.ts` belongs to the root's toolchain: it is part of the
  root's TypeScript program and its ESLint run (`npm run typecheck` and `npm run lint` at the
  repository root), because it is written against the root's dependencies and would otherwise be
  checked by nothing - Playwright strips types without checking them. It therefore follows
  `docs/guidelines/`, not the framework's conventions. The texts it asserts must not depend on the
  machine the browser runs on: an application that follows the browser's language is loaded with
  its language fixed (for OpenUI5, `?sap-ui-language=en`).

## Without a device

The smoke tests install the stand-in from the test side. To run an example by hand without any
hardware, an example may offer a `?stand-in` query flag (or similar) that installs the stand-in
itself before importing the library - as `test/browser/stand-in/web-serial-stand-in.ts` describes.
With a real device attached, the browser's port picker is used as in any application.
