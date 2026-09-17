# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor.

The **wire protocol version** is tracked separately from the package version, because tabs running
different protocol versions do not coordinate with each other. It is noted whenever it changes. See
[ADR-0008](./docs/adr/0008-wire-protocol-and-versioning.md).

## [Unreleased]

### Added

- **A page opened from a file works.** `isSupported()` answered `false` and `setup()` raised
  `WEB_LOCKS_UNAVAILABLE` for a page loaded from `file://`, because its origin reads `null` like a
  sandboxed frame's. Chromium treats the two differently: between pages opened from files, Web Locks
  are granted and contended, a `BroadcastChannel` delivers and `localStorage` is shared; only a
  `SharedWorker` is refused, and the transport falls back from that by itself. A folder copied to a
  station and opened with a double click is now a supported place to run - with the classic script
  build, since such a page may load no ES module. Measured in Edge 153 against the stand-in and
  against the Arduino through the browser's own picker.

- **A terminal in SAP OpenUI5**, `examples/terminal-openui5`, in `sap_horizon` and
  `sap_horizon_dark`. Its connection handling is one button: _Connect_ shows the connection settings
  of the last time, sets up and asks for the port in the same click, and stays open until there is a
  connection; _Disconnect_ forgets the port and the remembered connection, which is also how the
  port is changed. Text and hex, ANSI colours, timestamps, a saved log. Its build runs from a folder
  opened as a file, with no server and no internet: a self-contained bundle with the text bundles
  and locale data OpenUI5 would otherwise fetch embedded into it. Checked against the Arduino through
  the browser's own picker.

- **`llms.txt`**, in the repository and in the package: what a language model needs to integrate the
  library correctly - entry points, the API with every default, statuses, events, error codes, the
  rules that matter - in about 3 000 tokens.

### Changed

- **`USER_GESTURE_REQUIRED` says what is true.** Its remediation and the documentation claimed that any
  `await` before `requestAccess()` uses the click up. Chromium counts a click as a gesture for a few
  seconds; only what outlasts them loses it. Measured with the browser's own picker: `setup()` and
  then `requestAccess()` from one click opens it.

- **The debugging surface's files are named after the package**: `dist/debug/serial-broker-debug.js`
  and `serial-broker-debug.css`, where they were `debug.js` and `debug.css` - names that say nothing
  once the files lie on a web server (ADR-0043 gave the library's own files theirs).

- **The OpenUI5 terminal's build is 10 MB in fifty files**, where it was 43 MB in 2 700: it keeps the
  bundle, the six framework modules and the theme files the page asks for - found by recording every
  request of a walk through the whole page - and nothing else. The examples type-check with the
  repository's TypeScript instead of installing their own.

- **The documentation's navigation has two arrows, up and down**, each shown only while there is more
  its way, each moving the list two thirds of what is visible. The single arrow back to the top
  never disappeared: the style sheet's `display: flex` won over the `hidden` attribute.

### Removed

- **Eleven example applications**, on Tim's decision of 2026-09-17: `terminal`, `minimal`,
  `multi-tab-dashboard`, `exclusive`, `no-bundler`, `openui5`, `openui5-js`, `react`, `vue`,
  `svelte` and `angular`, with their smoke tests, their dependency trees and everything that
  referred to them. Two remain: `minimal-js`, one page without a toolchain, and
  `terminal-openui5`.

## [0.1.0-alpha.1] - 2026-09-17

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
- **Received bytes are collected until the line is quiet** (ADR-0002): `receive.idleMs` and
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
- **Not on the npm registry before 1.0.** A release attaches `serial-broker-<version>.tgz`, and
  `npm install ./serial-broker-<version>.tgz` installs it; checked with a project of its own, where
  the ES module, the CommonJS build and the types resolve under `node16` and `bundler`.
- **A read-only diagnostics entry point**, `serial-broker/diagnostics`, and **a debugging surface**
  shipped as static content in `dist/debug/` under its own content security policy (ADR-0018,
  ADR-0019). It lists every configuration of the origin, connects, edits and disconnects, and asks
  what should be forgotten.
- **A terminal application**, `examples/terminal`: the first application built on this library and
  the one to read first. Connection settings, text and hex in both directions, ANSI colours,
  timestamps, auto-scroll, saved logs, a dark theme, a send history, and an experimental file
  transfer that sends raw bytes in chunks. Static HTML with an import map, no build step, no
  dependencies at run time; open it in two tabs to watch one port serve both.
- **Twelve example applications**, each with a README, a fixed port and a Playwright smoke test:
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
  (`SERIAL_BROKER_HARDWARE=arduino|emulator`) that name the manual test plan's steps they run;
  Chromium's own port picker answered through Windows UI Automation
  (`SERIAL_BROKER_HARDWARE=picker`) and a tab really in the background (`npm run test:background`),
  both opt-in because they show a window; an opt-in extreme-usage suite (`npm run test:extreme`).
- **Benchmarks judged against expectations written down first** (ADR-0037), with build sizes, in
  the Performance chapter.
