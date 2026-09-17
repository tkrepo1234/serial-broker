# Examples

The examples build on each other, in four tiers, with a complete page for a site without a
toolchain beside them.

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

| Application                                                                                                  | What it shows                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [examples/terminal-openui5](https://github.com/tkrepo1234/serial-broker/tree/main/examples/terminal-openui5) | A serial terminal as a SAP OpenUI5 application in `sap_horizon` and `sap_horizon_dark`. Its build runs from a folder opened as a file, with no server and no internet. |
| [examples/minimal-js](https://github.com/tkrepo1234/serial-broker/tree/main/examples/minimal-js)             | One page in plain JavaScript, as one HTML file: an import map, one inline module script, no build step - the way in for a page that owns no toolchain.                 |
