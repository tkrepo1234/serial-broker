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

## In a framework
## Runnable applications

The examples above are plain TypeScript and fit into any framework. Complete applications live in
the repository rather than here, because each is a project of its own with a toolchain of its own.
[examples/multi-tab-dashboard](https://github.com/tkrepo1234/serial-broker/tree/main/examples/multi-tab-dashboard)
is a Vite and TypeScript dashboard in plain DOM that names every status, shows every error with its
code and remediation, asks for permission from the one click that needs it, remembers and restores
the device, lists what the other tabs see, and shows the diagnostics entry point read-only. One
worked-out framework integration is a project of its own too:
## Runnable applications

The examples above are plain TypeScript and fit into any framework. Worked-out integrations live
in the repository rather than here, because each is a project of its own:
[examples/openui5](https://github.com/tkrepo1234/serial-broker/tree/main/examples/openui5) is a
runnable [OpenUI5](https://openui5.org) application together with a reusable module - a `JSONModel`
that mirrors one configuration and is bindable in XML views - and a README that explains how to
take it into an application of your own.

[examples/exclusive](https://github.com/tkrepo1234/serial-broker/tree/main/examples/exclusive) is
a Vite page without a framework that uses a device with `maxTabs: 1`: it shows `queued` as a wait,
the takeover when the tab in front releases the device or closes, and a release button.
[examples/no-bundler](https://github.com/tkrepo1234/serial-broker/tree/main/examples/no-bundler)
is a static page with no build step - `serial-broker/min` from an import map, the worker script
served next to it, `configure({ workerUrl })` spelled out - for a front end that a site's existing
web server delivers.
