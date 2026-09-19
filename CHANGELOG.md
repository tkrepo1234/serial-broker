# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor.

The **wire protocol version** is tracked separately from the package version, because tabs running
different protocol versions do not coordinate with each other. It is noted whenever it changes. See
[ADR-0007](./docs/adr/0007-wire-protocol-and-versioning.md).

## [Unreleased]

## [0.1.0-beta.3] - 2026-09-19

The library of 0.1.0-beta.2, released under the next number: 0.1.0-beta.2 was tagged, but its
release stopped at a browser test that failed on the CI runner. The fault was in the test's Web
Serial stand-in, which read what a test had told another page from `localStorage` - where Chromium
makes a write visible later than a `BroadcastChannel` message sent after it. Nothing of the
published package changed but the version. What it brings is listed under 0.1.0-beta.2 in
`CHANGELOG.md`: `VERSION`, `ReceiveEvent.afterGap`, and the fixes since 0.1.0-beta.1.

## [0.1.0-beta.2] - 2026-09-19

### Added

- **`ReceiveEvent.afterGap`** says that bytes may be missing before a delivery, in the tab it
  reaches: its first delivery, the first after the status left `open`, and the first after its
  message bus replaced a worker that died - the one case the status does not show. An application
  assembling lines or frames drops the one in progress; the examples do so instead of watching the
  status.
- **`VERSION`**, the release of the package, exported beside `PROTOCOL_VERSION` and on the classic
  script's global. Every published script names the same release in a comment on its first line, so
  a worker script left on a server from an earlier release can be recognised without loading it,
  and the debugging surface shows the release it was built from.

### Changed

- **The documentation says what it takes to run each example**, after following every page of it
  literally in a fresh project: the worker script is part of "running it", the classic-script page
  asks for a port as it must, the page opened from a file has its own snippet with relative paths,
  the content security policy allows the icon the pages declare, and the hash of an import map is
  computed by `scripts/importmap-hash.mjs` rather than by a one-liner that only runs in a POSIX
  shell.

### Fixed

- **Device data a script of the origin made up is not delivered**, even when it claims a term
  first and sends the data before the tabs have checked that claim's lock. Data from a sender whose
  term is being checked waits for the answer, behind the claim, and goes with it when nobody holds
  the lock. A new holder's bytes no longer reach a tab before the status that says the port moved.
- **A port another program holds is reported as `OPEN_FAILED`**, not as `DEVICE_DISCONNECTED`.
  Chromium answers every refusal of `open()` with a `NetworkError`, and the commonest one by far is
  a terminal program or driver tool holding the port; the operator now reads "Another application
  may hold the device" instead of "No action required". A device that is really away never reaches
  `open()` and is unaffected.
- **`release(name, { forget: true })` forgets.** A tab lets go of its own hold on the remembered
  entry and asks for it exclusively in the same breath; the browser can still have the withdrawn
  request in its queue and refuse a lock that nothing holds, and the entry then stayed with nothing
  said. The refusal is now checked against what the browser reports as held.
- **An unplugged device is reported as `DEVICE_DISCONNECTED`**, not as `READ_FAILED`. The browser
  rejects the read of the open port before it says the device is gone, so the tab holding the port
  learned of the loss from the read and showed the advice for a line that is misbehaving - check
  the cable, check the line settings - for a device someone had just unplugged.
- **Writes are taken again after a connection is lost while one was stalled.** A chunk the device
  never took holds the write queue, as it must while that connection lasts; it no longer holds it
  across the reconnect, where every later write timed out against a connection that was open and
  well.
- **`unsubscribe()` refuses an event name it does not know**, and a listener that is not a
  function, as `subscribe()` does and as its documentation says: a misspelt name removed nothing
  and said nothing.
- **`requestAccess()` answers the same in every tab** while the connection is open: it opens no
  picker. The tab holding the port used to open one, which told the caller which tab that was.
- **The OpenUI5 terminal** keeps line settings the library refused out of its summary and out of
  the next visit, offers its file dialog again after it has been used once, says that hex it cannot
  read is the line rather than a fault of the page, and leaves no blank line after each received
  one. **The debugging surface** no longer leaves a configuration behind when the picker is
  dismissed, and carries the product's icon.

## [0.1.0-beta.1] - 2026-09-17

The first release, so this section says what the library is: **wire protocol version 1**, **storage
version 1**. Before 1.0 a minor version may break the API, the protocol and the storage format.

### Added

**The library**

- **One Web Serial port, shared by every tab of an origin.** One tab holds the port; every tab
  reads and writes through it, addressing the device by a configuration name. Which tab holds it is
  deliberately not visible (ADR-0009).
- **Failover without cooperation.** The tab holding the port can close, crash or be killed; the
  next tab takes over, because ownership is a Web Lock the browser frees on its own (ADR-0005).
- **Automatic reconnection** with bounded exponential backoff and jitter, short-circuited when
  the browser reports the device plugged in again. With `connection.autoReconnect: false` a loss
  ends in `failed`, and nothing retries until `setup()` is called again (ADR-0008).
- **At-most-once writes.** Writes of one tab keep their order, and a write is never written twice:
  the tab holding the port asks the issuing tab before it begins a write from it, so a crash
  reports `OWNER_LOST_DURING_WRITE` rather than handing the write on (ADR-0011).
- **Four ways to name the device** (ADR-0022): `device` omitted or `{ auto: true }` takes the device
  from the port the user picks in an unfiltered picker, remembers it, and shares it with the other
  tabs; `{ vendorId, productId }` names a USB device; `{ nonUsb: true }` accepts only ports without
  a USB identity; `{ any: true }` accepts any granted port. `getStatus()` reports `deviceKind`.
- **Received bytes are collected until the line is quiet** (ADR-0002), with `receive.idleMs` and
  `receive.maxWaitMs`, and delivered as the same event in every tab - each listener with a copy of
  its own. Text is decoded on request, a character split across reads decoded whole (ADR-0013).
- **Remembered configurations**, one storage key each plus an index (ADR-0020), kept while any tab
  runs them. Releasing forgets nothing: `release(name, { forget: true })` and
  `{ forgetDevice: true }` say what goes, each of them from any tab.
- **One error type**, stable codes, a remediation sentence for every one, and a typed
  `SerialBrokerErrorContext` whose fields are documented per code (ADR-0010).
- **A limit on how many tabs use a configuration at once**, `maxTabs` (ADR-0017): further tabs wait
  as `queued` and move up when a place is free.
- **Web Locks tell who is there** (ADR-0024): the worker forgets a tab the moment the browser frees
  that tab's lock, and tabs replace a worker the moment its lock is freed - no heartbeats.
- **A `SharedWorker` carries the bus**, with a `BroadcastChannel` fallback where there is none
  (ADR-0006). Every message is validated and bounded, and what the bus can cost a tab is
  rate-limited (ADR-0019); `SECURITY.md` states the trust boundary.
- **A page opened from a file works**: a folder copied to a station and opened with a double click,
  with the classic script build and the `BroadcastChannel` bus.

**Entry points and builds**

- **`serial-broker`** as ES module and CommonJS with type definitions, **`serial-broker/min`** as a
  minified ES module, and **`serial-broker/global`**, a classic script build that puts the whole
  surface on one global, `SerialBroker`, for a page that writes no modules (ADR-0026).
  `configure({ workerUrl })` is required with the classic and CommonJS builds, before the first
  `setup()`.
- **`serial-broker/worker`**, the worker script, served by the application at one URL for every
  tab.
- **`serial-broker/diagnostics`**, a read-only observer of every tab of the origin, in the same
  three forms (ADR-0014).
- **Published files are named after the package** - `serial-broker.js`, `serial-broker.cjs`,
  `serial-broker.min.js`, `serial-broker.global.js`, `serial-broker.worker.js`,
  `serial-broker.diagnostics.*` - each with its source map.
- **Not on the npm registry before 1.0.** A release attaches `serial-broker-<version>.tgz`, which
  `npm install ./serial-broker-<version>.tgz` installs, and `serial-broker-<version>-browser.zip`
  for a page with no package manager.

**The debugging surface**

- **Static content in `dist/debug/`** under its own content security policy, served only where an
  operator serves it (ADR-0015). It lists every configuration of the origin with the tabs that use
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

- **A documentation site** built with Sphinx from the chapters and the source comments (ADR-0016):
  installing, deploying, a first connection, guarantees, how shared ports behave, configuration,
  errors, diagnostics, known limits, tiered examples, a comparison with plain Web Serial, internals,
  performance measured against expectations written first (ADR-0023), and the interface,
  generated from the source.
- **`llms.txt`**, in the repository and in the package: what a language model needs to integrate
  the library correctly - entry points, the API with every default, statuses, events, error codes,
  the rules that matter.
- **An icon**, `docs/icon.svg`: one serial port with three in it, the tabs that share it.

**How it is tested**

- **In-process** against a simulated browser, on both transports, with a documentation test that
  checks documented defaults, ranges and log events against the source.
- **In a real browser** on every CI run against a Web Serial stand-in (ADR-0021), the debugging
  surface and both examples included.
- **On hardware**, opt-in: an Arduino echo board and the USB/IP emulator
  (`SERIAL_BROKER_HARDWARE=arduino|emulator`), Chromium's own port picker answered through Windows
  UI Automation (`SERIAL_BROKER_HARDWARE=picker`), a tab really in the background
  (`npm run test:background`), and an extreme-usage suite (`npm run test:extreme`). The
  [manual test plan](./docs/manual-test-plan.md) records the last run.
