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

The examples above are plain TypeScript and fit into any framework. Worked-out integrations live
in the repository rather than here, because each is a project of its own:
[examples/openui5](https://github.com/tkrepo1234/serial-broker/tree/main/examples/openui5) is a
runnable [OpenUI5](https://openui5.org) application together with a reusable module - a `JSONModel`
that mirrors one configuration and is bindable in XML views - and a README that explains how to
take it into an application of your own.
[examples/no-bundler](https://github.com/tkrepo1234/serial-broker/tree/main/examples/no-bundler)
is a static page with no build step - `serial-broker/min` from an import map, the worker script
served next to it, `configure({ workerUrl })` spelled out - for a front end that a site's existing
web server delivers.
