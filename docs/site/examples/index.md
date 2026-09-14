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

The Simple tier also exists as a runnable application with a smoke test,
[examples/minimal](https://github.com/tkrepo1234/serial-broker/tree/main/examples/minimal): one
Vite + TypeScript page that connects, prints what arrives and sends text, with every status, every
error's code and remediation, and a README on taking it into an application of your own.

## Runnable applications

The examples above are plain TypeScript and fit into any framework. Complete applications live in
the repository rather than here, because each is a project of its own with a toolchain of its own.
Each has a README that explains how to take its integration into an application of your own, and a
smoke test that runs it against a stand-in for the device.

| Application                                                                                               | What it shows                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [minimal](https://github.com/tkrepo1234/serial-broker/tree/main/examples/minimal)                         | One Vite + TypeScript page that connects, prints what arrives and sends text, with every status and every error's code and remediation.                                                                  |
| [multi-tab-dashboard](https://github.com/tkrepo1234/serial-broker/tree/main/examples/multi-tab-dashboard) | A plain-DOM dashboard: every status, every error, permission from the one click that needs it, remembering and restoring the device, what the other tabs see, and the diagnostics entry point read-only. |
| [exclusive](https://github.com/tkrepo1234/serial-broker/tree/main/examples/exclusive)                     | A device with `maxTabs: 1`: `queued` shown as a wait, the takeover when the tab in front releases the device or closes, and a release button.                                                            |
| [no-bundler](https://github.com/tkrepo1234/serial-broker/tree/main/examples/no-bundler)                   | A static page with no build step: `serial-broker/min` from an import map, the worker script served next to it, `configure({ workerUrl })` spelled out.                                                   |
| [openui5](https://github.com/tkrepo1234/serial-broker/tree/main/examples/openui5)                         | An [OpenUI5](https://openui5.org) application and a reusable module: a `JSONModel` that mirrors one configuration and is bindable in XML views.                                                          |
| [vue](https://github.com/tkrepo1234/serial-broker/tree/main/examples/vue)                                 | A Vue 3 application and a reusable composable, `useSerialBroker(name, options)`, that returns refs for the status, the last error and the received lines, with `connect`, `send` and `release`.          |
