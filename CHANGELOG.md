# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor.

The **wire protocol version** is tracked separately from the package version, because tabs running
different protocol versions do not coordinate with each other. It is noted whenever it changes. See
[ADR-0008](./docs/adr/0008-wire-protocol-and-versioning.md).

## [Unreleased]

The first release, so this section says what the library is: **wire protocol version 1**, **storage
version 1**. Before 1.0 a minor version may break the API, the protocol and the storage format.

### Added

**The library**

- **One Web Serial port, shared by every tab of an origin.** One tab holds the port; every tab
  reads and writes through it, addressing the device by a configuration name. Which tab holds it is
  deliberately not visible (ADR-0011).
- **Failover without cooperation.** The tab holding the port can close, crash or be killed; the
  next tab takes over, because ownership is a Web Lock the browser frees on its own (ADR-0005).
- **Automatic reconnection** with bounded exponential backoff and jitter, short-circuited when
  the browser reports the device plugged in again. With `connection.autoReconnect: false` a loss
  ends in `failed`, and nothing retries until `setup()` is called again (ADR-0010).
- **At-most-once writes.** Writes of one tab keep their order, and a write is never written twice:
  the tab holding the port asks the issuing tab before it begins a write from it, so a crash
  reports `OWNER_LOST_DURING_WRITE` rather than handing the write on (ADR-0013).
- **Four ways to name the device** (ADR-0036): `device` omitted or `{ auto: true }` takes the device
  from the port the user picks in an unfiltered picker, remembers it, and shares it with the other
  tabs; `{ vendorId, productId }` names a USB device; `{ nonUsb: true }` accepts only ports without
  a USB identity; `{ any: true }` accepts any granted port. `getStatus()` reports `deviceKind`.
- **Received bytes are collected until the line is quiet** (ADR-0002), with `receive.idleMs` and
  `receive.maxWaitMs`, and delivered as the same event in every tab - each listener with a copy of
  its own. Text is decoded on request, a character split across reads decoded whole (ADR-0015).
- **Remembered configurations**, one storage key each plus an index (ADR-0033), kept while any tab
  runs them. Releasing forgets nothing: `release(name, { forget: true })` and
  `{ forgetDevice: true }` say what goes, each of them from any tab.
- **One error type**, stable codes, a remediation sentence for every one, and a typed
  `SerialBrokerErrorContext` whose fields are documented per code (ADR-0012).
- **A limit on how many tabs use a configuration at once**, `maxTabs` (ADR-0025): further tabs wait
  as `queued` and move up when a place is free.
- **Web Locks tell who is there** (ADR-0041): the worker forgets a tab the moment the browser frees
  that tab's lock, and tabs replace a worker the moment its lock is freed - no heartbeats.
- **A `SharedWorker` carries the bus**, with a `BroadcastChannel` fallback where there is none
  (ADR-0006). Every message is validated and bounded, and what the bus can cost a tab is
  rate-limited (ADR-0031); `SECURITY.md` states the trust boundary.
- **A page opened from a file works**: a folder copied to a station and opened with a double click,
  with the classic script build and the `BroadcastChannel` bus.

**Entry points and builds**

- **`serial-broker`** as ES module and CommonJS with type definitions, **`serial-broker/min`** as a
  minified ES module, and **`serial-broker/global`**, a classic script build that puts the whole
  surface on one global, `SerialBroker`, for a page that writes no modules (ADR-0043).
  `configure({ workerUrl })` is required with the classic and CommonJS builds, before the first
  `setup()`.
- **`serial-broker/worker`**, the worker script, served by the application at one URL for every
  tab.
- **`serial-broker/diagnostics`**, a read-only observer of every tab of the origin, in the same
  three forms (ADR-0018).
- **Published files are named after the package** - `serial-broker.js`, `serial-broker.cjs`,
  `serial-broker.min.js`, `serial-broker.global.js`, `serial-broker.worker.js`,
  `serial-broker.diagnostics.*` - each with its source map.
- **Not on the npm registry before 1.0.** A release attaches `serial-broker-<version>.tgz`, which
  `npm install ./serial-broker-<version>.tgz` installs, and `serial-broker-<version>-browser.zip`
  for a page with no package manager.

**The debugging surface**

- **Static content in `dist/debug/`** under its own content security policy, served only where an
  operator serves it (ADR-0019). It lists every configuration of the origin with the tabs that use
  it and the one holding the port, shows traffic, settings, locks and granted ports, connects with
  no code through _Choose a device…_, edits and disconnects, and asks what to forget.

**The device emulator**

- **`npm run emulator`**: a USB CDC ACM serial device in software, a USB/IP server that usbip-win2
  attaches to Windows as an ordinary COM port. A loopback that can be unplugged, hung mid-write and
  made to split its answers on command.

**Examples**

- **`examples/minimal-js`**: one HTML page in plain JavaScript - an import map, one inline module
  script, no build step.
- **`examples/terminal-openui5`**: a serial terminal in SAP OpenUI5, in `sap_horizon` and
  `sap_horizon_dark`, with text and hex, ANSI colours, timestamps and a saved log. Its build runs
  from a folder opened as a file, with no server and no internet.

**Documentation**

- **A documentation site** built with Sphinx from the chapters and the source comments (ADR-0020):
  installing, deploying, a first connection, guarantees, how shared ports behave, configuration,
  errors, diagnostics, known limits, tiered examples, a comparison with plain Web Serial, internals,
  performance measured against expectations written first (ADR-0037), and a generated API
  reference.
- **`llms.txt`**, in the repository and in the package: what a language model needs to integrate
  the library correctly - entry points, the API with every default, statuses, events, error codes,
  the rules that matter.
- **An icon**, `docs/icon.svg`: one serial port with three in it, the tabs that share it.

**How it is tested**

- **In-process** against a simulated browser, on both transports, with a documentation test that
  checks documented defaults, ranges and log events against the source.
- **In a real browser** on every CI run against a Web Serial stand-in (ADR-0035), the debugging
  surface and both examples included.
- **On hardware**, opt-in: an Arduino echo board and the USB/IP emulator
  (`SERIAL_BROKER_HARDWARE=arduino|emulator`), Chromium's own port picker answered through Windows
  UI Automation (`SERIAL_BROKER_HARDWARE=picker`), a tab really in the background
  (`npm run test:background`), and an extreme-usage suite (`npm run test:extreme`). The
  [manual test plan](./docs/manual-test-plan.md) records the last run.
