# Examples

The examples build on each other, in four tiers.

```{toctree}
:maxdepth: 1

simple
all-features
full-featured
advanced
```

| Tier                              | What it shows                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| [Simple](simple.md)               | The smallest page that works: set up, receive, send.                                        |
| [All features](all-features.md)   | Every capability on its own: permission, status, text and binary, errors, release, restore. |
| [Full-featured](full-featured.md) | A realistic application that uses them together.                                            |
| [Advanced](advanced.md)           | The hard cases: failover-safe commands, a protocol layer on top, several devices at once.   |

## Runnable applications

The examples above are plain TypeScript and fit into any framework. Complete applications live in
the repository rather than here, because each is a project of its own with a toolchain of its own.
Each one has a smoke test and a README on taking it into an application of your own.

| Application                                                                                               | What it shows                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [minimal](https://github.com/tkrepo1234/serial-broker/tree/main/examples/minimal)                         | The Simple tier as a Vite and TypeScript page: connect, print what arrives, send text, with every status and every error's code and remediation.                                                          |
| [multi-tab-dashboard](https://github.com/tkrepo1234/serial-broker/tree/main/examples/multi-tab-dashboard) | A dashboard in plain DOM: every status, errors with code and remediation, the one permission click, remembering and restoring the device, what the other tabs see, the diagnostics entry point read-only. |
| [exclusive](https://github.com/tkrepo1234/serial-broker/tree/main/examples/exclusive)                     | `maxTabs: 1`: `queued` shown as a wait, the takeover when the tab in front releases the device or closes, and a release button.                                                                           |
| [no-bundler](https://github.com/tkrepo1234/serial-broker/tree/main/examples/no-bundler)                   | A static page with no build step: `serial-broker/min` from an import map, the worker script served next to it, `configure({ workerUrl })` spelled out.                                                    |
| [openui5](https://github.com/tkrepo1234/serial-broker/tree/main/examples/openui5)                         | [OpenUI5](https://openui5.org): a reusable `JSONModel` that mirrors one configuration and is bindable in XML views.                                                                                       |
| [react](https://github.com/tkrepo1234/serial-broker/tree/main/examples/react)                             | React 19: a reusable `useSerialBroker` hook on `useSyncExternalStore`, shared by several components, safe under StrictMode and hot updates, and how to publish it as a package.                           |
