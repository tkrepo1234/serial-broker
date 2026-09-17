<img src="./docs/icon.svg" alt="" width="72" height="72" align="right" />

# serial-broker

One serial port, every tab.

> **Alpha.** The API may still change between releases. Tested in a simulated
> browser, in a real browser, and against an Arduino echo board and the USB/IP device emulator
> ([manual test plan](./docs/manual-test-plan.md)) — a first run, not a field record.

The [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) lets one tab
open a serial device; every other tab gets `InvalidStateError`. serial-broker lets every tab of an
origin use the port: one tab holds it, every tab reads and writes through it, another tab takes over
when that tab goes away, and the connection comes back when the device does.

It is built for industrial use — production interfaces that talk to scales, scanners, printers,
PLCs and instruments — where simple installation and predictable behaviour matter: one package and
one worker script, no native helper or extension, a stable code for every failure, every limit
written down.

![serial-broker at a glance: with Web Serial alone one tab opens the port and the others are refused; with serial-broker one tab holds the port and every tab reads and writes through a message bus. The library runs in every tab of one origin, on top of Web Serial, Web Locks and localStorage. Four situations: several tabs on one device, the holding tab going away, the device being unplugged, and a limit of one tab.](./docs/at-a-glance.svg)

| Capability                | What it means                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Shares one port**       | Every tab reads and writes. A write reaches the device at most once.                                      |
| **Survives tabs closing** | Another tab takes over when the tab holding the port closes, crashes or is killed.                        |
| **Reconnects**            | A device unplugged or switched off is reopened with the same settings when it returns, unless turned off. |
| **Remembers the device**  | The user chooses the port once; later visits connect with no prompt, in every tab.                        |
| **Delivers what arrives** | Received bytes are collected until the line is quiet, the same in every tab; text is decoded on request.  |
| **Limits who uses it**    | Optionally at most N tabs at once, 1 for exclusive use; the others wait their turn.                       |

<!-- landing-snippet:start -->

```ts
import { SerialBroker } from 'serial-broker';

// In every tab, on every page load.
await SerialBroker.setup('CardReader', {
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});

SerialBroker.subscribe('CardReader', 'onReceive', (event) => console.log(event.text));

// The first time only: the user chooses the port, from a click.
connectButton.addEventListener('click', () => void SerialBroker.requestAccess('CardReader'));

sendButton.addEventListener('click', () => void SerialBroker.send('CardReader', 'STATUS?\r\n'));
```

<!-- landing-snippet:end -->

## Install

serial-broker is not on npm before 1.0. Every [release](https://github.com/tkrepo1234/serial-broker/releases) attaches the package, and npm
installs it from the file:

```sh
npm install ./serial-broker-<version>.tgz
```

Where the documentation and the examples say `npm install serial-broker`, that is this command until
1.0. A page without a package manager takes `serial-broker-<version>-browser.zip` from the same
release instead.

Serve `serial-broker.worker.js` from the application's origin, and name its URL before the first
`setup()`: `SerialBroker.configure({ workerUrl })`. **Requirements:** a Chromium-based desktop browser,
a secure context (HTTPS or `localhost`), all tabs on one origin.

## Documentation

The documentation site is built with `npm run docs`; its chapters are readable here as well.

| Topic                                   | Chapter                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| What it is, installing, a first page    | [Introduction](./docs/site/introduction.md), [Installing](./docs/site/installing.md), [First connection](./docs/site/first-connection.md) |
| What you can rely on, and what not      | [Guarantees](./docs/site/guarantees.md), [Known limits](./docs/site/known-limits.md)                                                      |
| How tabs share a port                   | [How shared ports behave](./docs/site/shared-ports.md)                                                                                    |
| Every option, every error code          | [Configuration](./docs/site/configuration.md), [Errors](./docs/site/errors.md)                                                            |
| Logging, diagnostics, debugging surface | [Diagnostics](./docs/site/diagnostics.md)                                                                                                 |
| Examples                                | [Four tiers](./docs/site/examples/index.md), [runnable applications](./examples/README.md)                                                |
| How it is built                         | [Internals](./docs/site/internals.md), [Performance](./docs/site/performance.md)                                                          |

## Repository layout

| Path                            | Contents                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `src/`, `test/`                 | The library; its tests on a simulated browser, in a real browser, on hardware. |
| `debug/`                        | The debugging surface, shipped in `dist/debug/`.                               |
| `examples/`                     | Runnable example applications, one toolchain each.                             |
| `emulator/`, `bench/`           | A USB/IP serial device emulator; benchmarks and their expectations.            |
| `docs/site/`                    | The documentation site (Sphinx).                                               |
| `docs/adr/`, `docs/guidelines/` | Architecture decision records; the binding engineering guidelines.             |
| `docs/manual-test-plan.md`      | The hardware test plan and its last run.                                       |
| `llms.txt`                      | What a language model needs to integrate the library; ships with the package.  |
| `scripts/`, `BACKLOG.md`        | Build and release helpers; open work.                                          |
| `config/`                       | The toolchain's configuration: Prettier, tsup, Vitest, Playwright, TypeDoc.    |

## Development

```sh
npm install
npm test             # unit and integration tests
npm run verify       # format, lint, types, tests with coverage gates, build
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) before changing anything.

## Licence

MIT
