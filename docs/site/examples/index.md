# Examples

The examples build on each other, in four tiers.

```{toctree}
:maxdepth: 1

simple
all-features
full-featured
advanced
no-build-step
```

| Tier                              | What it shows                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| [Simple](simple.md)               | The smallest page that works: set up, receive, send.                                        |
| [All features](all-features.md)   | Every capability on its own: permission, status, text and binary, errors, release, restore. |
| [Full-featured](full-featured.md) | A realistic application that uses them together.                                            |
| [Advanced](advanced.md)           | The hard cases: failover-safe commands, a protocol layer on top, several devices at once.   |
| [No build step](no-build-step.md) | The complete page for a site with no toolchain: one HTML file, in plain JavaScript.         |

## Runnable applications

The examples above are plain TypeScript and fit into any framework. Complete applications live in
the repository rather than here, because each is a project of its own with a toolchain of its own.
Each has a README on taking its integration into an application of your own, and a smoke test that
runs it in a real browser against a Web Serial stand-in.

| Application                                                                                                        | What it shows                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [examples/terminal](https://github.com/tkrepo1234/serial-broker/tree/main/examples/terminal)                       | **The terminal, and the one to read first**: connection settings, text and hex, ANSI colours, timestamps, saved logs, a dark theme and an experimental file transfer. Static HTML, no build step.        |
| [examples/minimal](https://github.com/tkrepo1234/serial-broker/tree/main/examples/minimal)                         | The Simple tier as a Vite and TypeScript page: connect, print what arrives, send text, every status and every error with its code and remediation.                                                       |
| [examples/minimal-js](https://github.com/tkrepo1234/serial-broker/tree/main/examples/minimal-js)                   | The same page in plain JavaScript, as one HTML file: an import map, one inline module script, no build step - the way in for a page that owns no toolchain.                                              |
| [examples/multi-tab-dashboard](https://github.com/tkrepo1234/serial-broker/tree/main/examples/multi-tab-dashboard) | A dashboard in plain DOM: permission from the one click that needs it, remembering and restoring, what the other tabs see, the diagnostics entry point.                                                  |
| [examples/exclusive](https://github.com/tkrepo1234/serial-broker/tree/main/examples/exclusive)                     | `maxTabs: 1`: `queued` shown as a wait, the takeover when the tab in front releases the device or closes, a release button.                                                                              |
| [examples/no-bundler](https://github.com/tkrepo1234/serial-broker/tree/main/examples/no-bundler)                   | A static page with no build step: `serial-broker/min` from an import map, the worker script served next to it, `configure({ workerUrl })` spelled out.                                                   |
| [examples/openui5](https://github.com/tkrepo1234/serial-broker/tree/main/examples/openui5)                         | An [OpenUI5](https://openui5.org) application with a reusable module: a `JSONModel` that mirrors one configuration and is bindable in XML views.                                                         |
| [examples/openui5-js](https://github.com/tkrepo1234/serial-broker/tree/main/examples/openui5-js)                   | The same OpenUI5 application and module in classic SAPUI5 JavaScript: `sap.ui.define`, `.extend()`, no transpile step.                                                                                   |
| [examples/react](https://github.com/tkrepo1234/serial-broker/tree/main/examples/react)                             | React 19: a reusable `useSerialBroker` hook on `useSyncExternalStore`, shared by several components, safe under StrictMode and hot updates, and how to publish it as a package.                          |
| [examples/vue](https://github.com/tkrepo1234/serial-broker/tree/main/examples/vue)                                 | A Vue 3 application and a reusable composable, `useSerialBroker(name, options)`, that returns refs for the status, the last error and the received lines, with `connect`, `send` and `release`.          |
| [examples/svelte](https://github.com/tkrepo1234/serial-broker/tree/main/examples/svelte)                           | A [Svelte 5](https://svelte.dev) application with a reusable module: `createSerialBroker()` exposes one configuration as rune-based reactive state and actions, set up on mount and released on destroy. |
| [examples/angular](https://github.com/tkrepo1234/serial-broker/tree/main/examples/angular)                         | An [Angular](https://angular.dev) application with a reusable module: an injectable `SerialBrokerService` whose signals a template reads, zoneless.                                                      |
