# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor.

The **wire protocol version** is tracked separately from the package version, because tabs running
different protocol versions do not coordinate with each other. It is noted whenever it changes. See
[ADR-0008](./docs/adr/0008-wire-protocol-and-versioning.md).

## [Unreleased]

The first release. Nothing has been published under this name, so this section describes what the
library is rather than what changed: **wire protocol version 1**, **storage version 1**.

Verified against real hardware - an Arduino echo board and the USB/IP device emulator attached by
usbip-win2 - in Microsoft Edge on Windows. Before 1.0 a minor version may break the API.

### The library

- **One Web Serial port, shared by every tab of an origin.** One tab holds the port; every tab
  reads and writes through it, addressing the device by a configuration name. Which tab holds it is
  deliberately not visible (ADR-0011).
- **Failover without cooperation.** The tab holding the port can close, crash or be killed; the
  next tab takes over, because ownership is a Web Lock the browser frees on its own (ADR-0005).
- **Automatic reconnection** with bounded exponential backoff and full jitter, short-circuited when
  the browser reports the device plugged in again. `connection.autoReconnect: false` turns it off:
  a loss then ends in `failed` and nothing retries until `setup()` is called again (ADR-0010).
- **At-most-once writes.** Per-participant ordering, and a write is never written twice - the tab
  holding the port asks the issuing tab before it begins a write from it, so a crash reports
  `OWNER_LOST_DURING_WRITE` rather than handing the write on (ADR-0013).
- **Automatic device mode** (ADR-0036): `device` may be omitted, or `{ auto: true }`; the
  configuration takes its device from the port the user picks in an unfiltered picker, remembers it,
  and shares it with the other tabs. `{ nonUsb: true }` accepts only ports without a USB identity,
  and `getStatus()` reports `deviceKind`: `'usb'`, `'non-usb'`, `'any'` or `'auto'`.
- **Received bytes are collected until the line is quiet** (ADR-0039): `receive.idleMs` and
  `receive.maxWaitMs`; the tab holding the port collects, and its settings apply everywhere.
- **Remembered configurations**, one storage key each plus an index (ADR-0033), kept while any tab
  runs them. Releasing forgets nothing: a disconnect is not a deletion, and `release(name,
{ forget: true })` or `{ forgetDevice: true }` say what should go - each of them from any tab,
  because what the browser stores belongs to the origin rather than to a tab.
- **One error type**, stable codes, a remediation sentence for every one, and a typed
  `SerialBrokerErrorContext` whose fields are documented per code and never promised to be present
  (ADR-0012).
- **A limit on how many tabs use a configuration at once** (`maxTabs`, ADR-0025); further tabs wait
  as `queued` and move up when a place is free. `getStatus()` reports the limit.
- **Web Locks tell who is still there** (ADR-0041): the worker forgets a tab the moment the browser
  frees that tab's lock, and tabs replace a worker the moment its lock is freed - no heartbeats.
- **A `SharedWorker` carries the bus**, with a `BroadcastChannel` fallback where there is none
  (ADR-0006); after a switch a tab restates what it takes part in rather than replaying traffic.

### What ships

- **Builds**: ESM, CommonJS, minified ESM, and a classic script build that puts the whole surface on
  one global, `SerialBroker`, for a page that writes no modules (ADR-0043). `configure({ workerUrl })`
  is required with the classic and CommonJS builds, before the first `setup()`: neither can locate
  the worker, and the library never guesses one.
- **Published files are named after the package**: `serial-broker.js`, `serial-broker.cjs`,
  `serial-broker.min.js`, `serial-broker.d.ts`, `serial-broker.global.js`,
  `serial-broker.diagnostics.*` and `serial-broker.worker.js`, each with its source map. Every
  release also attaches `serial-broker-<version>-browser.zip` for a page with no package manager.
- **A read-only diagnostics entry point**, `serial-broker/diagnostics`, and **a debugging surface**
  shipped as static content in `dist/debug/` under its own content security policy (ADR-0018,
  ADR-0019). It lists every configuration of the origin, connects, edits and disconnects, and asks
  what should be forgotten.
- **Eleven example applications**, each with a README, a fixed port and a Playwright smoke test:
  `minimal`, `minimal-js`, `multi-tab-dashboard`, `exclusive`, `no-bundler`, `openui5`,
  `openui5-js`, `react`, `vue`, `svelte` and `angular`.
- **Documentation** built with Sphinx from the chapters and the source comments (ADR-0020):
  Guarantees, First connection, Known limits, Tasks, Performance, and a generated API reference.
  `npm run docs:links` checks where its links lead.

### How it is tested

- **In-process** against a simulated browser: 1 433 tests, including a documentation test that
  checks documented defaults, ranges and log events against the source.
- **In a real browser** on every CI run against a Web Serial stand-in (ADR-0035), the debugging
  surface included; opt-in hardware runs against an Arduino and the USB/IP emulator
  (`SERIAL_BROKER_HARDWARE=arduino|emulator`) that name the manual test plan's steps they run; an
  opt-in extreme-usage suite (`npm run test:extreme`).
- **Benchmarks judged against expectations written down first** (ADR-0037), with build sizes, in
  the Performance chapter.
