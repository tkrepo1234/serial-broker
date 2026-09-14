# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor.

The **wire protocol version** is tracked separately from the package version and is noted
explicitly whenever it changes, because tabs running different protocol versions do not
coordinate with each other. See
[ADR-0008](./docs/adr/0008-wire-protocol-and-versioning.md).

## [Unreleased]

**Wire protocol version 9.** Tabs of this build and tabs of an earlier one do not share a worker,
a lock or a bus; they detect each other and report `PROTOCOL_VERSION_MISMATCH`. Reload every tab
of an application after deploying it. Configurations remembered by an earlier build are not
migrated (see below).

### Added

- Framework integrations as runnable examples, each with a reusable module, a README on taking it
  into an application of your own and a smoke test: `examples/react` (a `useSerialBroker` hook on
  `useSyncExternalStore`, safe under StrictMode and hot updates and shared by several components),
  `examples/vue` (a `useSerialBroker` composable returning refs; composables of one name follow one
  configuration), `examples/svelte` (`createSerialBroker()` with rune-based state; a connection
  releases only what it set up) and `examples/angular` (an injectable `SerialBrokerService` with
  signals in a zoneless Angular 22 application). The examples table and the documentation's
  examples page list all nine applications.
- A documentation chapter, **Tasks, counted**, shows the code for seven common tasks with
  serial-broker and with the Web Serial API alone, and counts their calls, options and concepts.
  The usability review behind it (`docs/usability-review-2026-09-14.md`) answered the questions a
  cold read of the examples raised in the documentation: Installing names the `serial-broker/worker`
  export and recommends naming the worker URL, and the TSDoc of `setup()`, `release()`, the `queued`
  and `released` statuses and `ErrorEvent.name` now say what they left open.
- **Automatic device mode** (ADR-0036): `device` is optional in `setup()`. Without it, or with
  `{ auto: true }`, the configuration waits in `awaiting-permission` until `requestAccess()` opens
  an unfiltered port picker, and takes its device from the port the user picks: its vendor and
  product ID when the port reports both, otherwise a port without a USB identity. The resolved
  device is remembered, so `restore()` reconnects without a prompt, and shared with the other tabs:
  a tab in auto mode adopts the device of the tab holding the port. `requestAccess()` may be called
  right after `setup()` in the same click. An auto-mode configuration waits for the user even when
  exactly one port is granted, because that port may belong to another configuration. A later
  visit that calls only `setup()` opens the device remembered for that name without a prompt, and
  saving an unresolved configuration keeps a resolution already remembered under its name.
- A new device filter, `{ nonUsb: true }`, accepts only ports without a USB identity.
- `getStatus()` reports `deviceKind`: `'usb'`, `'non-usb'`, `'any'` or `'auto'`.
- The debugging surface's **Choose a device…** uses the automatic mode: it asks only for a name and
  the line settings, sets the configuration up and opens the picker in the same click; a dismissed
  picker releases the configuration again. **New configuration** defaults to automatic.
- `npm run bench`: benchmarks of throughput, latency, handover, start and a simulated hour on the
  in-process harness, over both transports, judged against expectations written down before the
  first measurement (ADR-0037), in about six seconds. An opt-in real-browser run
  (`SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser`, never in CI) measures the same in Edge
  with the Web Serial stand-in. A new Performance chapter holds both sets of results, the build
  sizes (reported, not enforced) and the documented limits; the size report includes the worker
  script.
- `npm run test:extreme`: an opt-in extreme-usage suite (`SERIAL_BROKER_EXTREME=1`, never in CI) of
  eleven scenarios on both transports - 100 tabs, sustained traffic of 41 MB to 10 tabs, 10 000
  writes under owner crashes, 50 000 writes through one holder, a simulated week - that bounds heap,
  timers, listeners, locks, pending writes and messages and checks that every tab still works at the
  end; and an opt-in real-browser run of 20 Edge pages for five minutes with the page holding the
  port closed every 30 s, its page and SharedWorker memory read over CDP. Both found no leak or
  stall in the library; the last runs are recorded in their `RESULTS.md`.
- The Web Serial stand-in can push bytes without a prior write (`emit()`), and the test harness
  counts bus messages and keeps nothing of closed or crashed tabs.
- `examples/openui5`: a runnable OpenUI5 application and a reusable integration module that
  exposes serial-broker as a bindable `JSONModel` - status, errors with remediation, traffic, send,
  connect and release - on OpenUI5 1.148 (long-term maintenance) with UI5 Tooling and TypeScript,
  running without an SAP system. Its German texts use real umlauts.
- Runnable example applications, each with its own README, a fixed port and a Playwright smoke
  test against the Web Serial stand-in: `examples/minimal` (a Vite page that connects, prints what
  arrives and sends text), `examples/multi-tab-dashboard` (permission, remembering and restoring,
  what the other tabs see, the diagnostics entry point), `examples/exclusive` (`maxTabs: 1`,
  `queued` shown as a wait, the takeover) and `examples/no-bundler` (a static page loading
  `serial-broker/min` from an import map, with a smoke test that checks the worker is really
  served). `examples/README.md` sets the contract every example keeps; `npm run test:examples`
  starts each example and runs its smoke test, and CI installs, type-checks and smoke-tests every
  example in one job.
- The built package is tested in a real browser on every CI run (`npm run test:browser`, Playwright,
  ADR-0035): three tabs of one origin sharing a port through a real `SharedWorker`, failover when
  the tab holding the port closes or its renderer is killed, recovery when that crash takes the
  broker with it, the `BroadcastChannel` fallback, a worker script of another protocol version, the
  port picker from a real click, an unplugged device coming back, and `dist/index.min.js`
  coordinating with tabs on the readable build. Locally the suite drives the installed Microsoft
  Edge; CI installs Chromium.
- First run against real hardware: an Arduino echoing at 9600 baud on a COM port - echo round trip,
  two and three tabs sharing the real port, failover when the tab holding it closes, a 5 000-byte
  payload byte for byte, 64 KiB complete and in order, and setting a configuration up again after
  releasing it. Opt-in with `SERIAL_BROKER_HARDWARE=arduino`, never in CI; the browser is handed the
  port through a throwaway profile written before it starts, so nothing answers a permission prompt
  and no machine-wide setting is touched. Recorded in `docs/manual-test-plan.md`.
- A reusable Web Serial stand-in (`test/browser/stand-in/`) installs a granted loopback device into
  any page before its own scripts run - for the browser tests, and for example applications that
  have to run without a device attached.
- The debugging surface connects to a device you pick: **Choose a device…** opens the browser's
  port picker with no filter and fills the setup in from the chosen port - its USB IDs, or _any
  port_ where it reports none, a free name, 9600 baud and the defaults for the rest. One
  **Connect** opens the port without a second prompt, because the picker just granted the
  permission. No vendor ID, product ID or device type is needed to get started (ADR-0034). The baud
  rate list offers 1200 to 921600; a dismissed picker changes nothing; the dialog warns before
  connecting when several granted ports match.
- The debugging surface ships a strict `Content-Security-Policy` in its markup: nothing but
  same-origin script, worker, style and fetch. `frame-ancestors` still has to
  come from the server as a header. Its styles now live in `dist/debug/debug.css`, which must be
  served next to `dist/debug/index.html`; serving `dist/` as a whole is unaffected.
- The SharedWorker's own diagnostics reach applications: it sends its `warn` records to the
  connected tabs, which log them through the configured logger as `worker.message-refused`,
  `worker.limit-exceeded`, `broker.limit-exceeded`, `worker.other-protocol-version` and
  `worker.message-error` (ADR-0029). Forwarding is throttled to eight records a minute; what
  exceeds that is counted and reported as `worker.records-dropped`. Such a record carries
  `clientId` for the context it concerns and `reportedBy` for the tab that wrote this copy.
- New error code `WRITE_QUEUE_FULL`: the tab holding the port keeps at most 4096 writes and 64 MiB
  of payload waiting at once, from every tab together; a write beyond that is refused, and nothing
  of it was written.
- `Clock` has a monotonic reading for durations (ADR-0032). The at-a-glance illustration was
  reworked in the documentation's style (`design/at-a-glance.svg`, `design/README.md`); it stays a
  draft, not yet referenced from the documentation.

### Changed

- **Breaking:** the `status` message carries the device of the tab holding the port (protocol
  version 9). `SerialBrokerStatusSnapshot` has the extra key `deviceKind`,
  `EffectiveSettings.device` in diagnostics is the full `DeviceFilter` union, and the context of
  `DEVICE_MISMATCH` gains `expectedDevice`. A `setup()` without `device`, which used to fail with
  `INVALID_ARGUMENT`, now waits for the user.
- A tab proves its identity to the SharedWorker with a random secret sent only in its `hello`
  (ADR-0028). Another script of the origin can no longer connect to the worker under a tab's
  identity, so it no longer receives what is addressed to that tab alone. A tab that replaces a
  worker that hung shows the same secret and keeps working. On `BroadcastChannel` no such protection
  is possible, and `SECURITY.md` says so.
- Every time of holding a port is a Web Lock of its own (ADR-0030). A tab believes a claim, a
  status or a goodbye about a term only while that lock is held, so a script of the origin can no
  longer end a term another tab is writing in, invent a term that makes other tabs address their
  writes into the void, or make a tab withdraw from a configuration by claiming another `maxTabs`.
  Failover after a crashed tab no longer waits out a grace period of one second: the term ends the
  moment the browser frees its lock. A word from a crashed tab still on its way when the browser
  freed its lock is now too late, which the documentation states.
- A write is reported started, or answered, only by the term it was addressed to and only by the
  tab that holds that term; device data is delivered only from a tab that speaks for a term the
  receiving tab knows of. A `write-result` forged with a request id read off the bus no longer
  resolves a write whose bytes are still waiting at the port.
- Answers to status requests and diagnostics requests, records of malformed messages, errors from
  other tabs and the reports one diagnostics collection keeps are rate-limited by named limits
  (ADR-0031); what is dropped is logged once per tab. Status requests beyond the rate are answered
  together, so no tab is left without a status.
- Remembered configurations are stored one per `localStorage` key,
  `serial-broker/configurations/v2/entry/<name>`, listed in `serial-broker/configurations/v2/index`
  (ADR-0033). Two tabs remembering different configurations at the same moment can no longer
  overwrite each other's entry, and one unreadable entry no longer risks the others.
  `STORAGE_CORRUPT` is reported per remembered configuration, with its `configName`. The diagnostics
  event `storage.migrated` is gone; `storage.old-format-discarded` reports the keys of earlier
  formats being removed.
- **Breaking:** configurations stored by earlier versions are not migrated. The keys
  `serial-broker/configurations/v1` and `serial-broker/v1/configurations` to
  `serial-broker/v4/configurations` are removed, unread, the first time `restore()` runs; those
  configurations have to be set up once more. The Web Lock that keeps a remembered configuration
  while a tab runs it is now `serial-broker/persisted/v2/<name>`.
- Setting the system clock no longer disturbs anything the library times. Durations - the
  `connection.stableAfterMs` stability window, how long a write has waited at the tab holding the
  port, how late a deadline ran, how long a tab has been silent, how much of a rate allowance has
  come back - are measured on `performance.now()`. Timestamps in events, errors and diagnostics
  remain system-clock readings.
- No published type definition names an ambient Web Serial type any more, including the
  definitions behind a deep import, so the package type-checks in an application without
  `@types/w3c-web-serial` under `skipLibCheck: false`. The public API types are unchanged in
  meaning; the build checks every emitted declaration.
- The README says who the library is for - industrial production interfaces - and what was run
  against real hardware, instead of saying it was never verified against a device.
- `owner-claimed` carries `maxTabs`, `HelloMessage` gains `secret`, the message type `worker-log`
  joins the protocol, and the internal export `FORMER_OWNER_GRACE_MS` is gone. For anyone
  constructing internals directly, `SerialBrokerEnvironment` and `TransportRequest` gain a
  required `newSecret()`.

## [0.1.0-alpha.1] - 2026-09-14

The first release, marked as an alpha: it has not yet been verified against a real serial device.

### Added

- Cross-tab sharing of a Web Serial port: one tab holds the port, every tab reads and writes.
- Automatic ownership failover when the owning tab closes, crashes, or is killed, using the
  Web Locks API so that recovery needs no cooperation from the departing tab.
- Automatic reconnection with bounded exponential backoff and full jitter, short-circuited
  when the platform reports the device has reappeared.
- Configuration persistence in `localStorage`, so a later visit reconnects with no prompt
  where the browser still holds the device permission.
- Text and binary payloads, with streaming text decoding that survives a multi-byte character
  split across chunks.
- A single error type with stable codes, structured context and a mandatory remediation
  sentence, faithfully reconstructed when an error crosses a tab boundary.
- A `BroadcastChannel` fallback for contexts without `SharedWorker`, such as Chrome for
  Android, functionally equivalent to the default. It also takes over when the worker script
  fails to load, replaying what the tab sent before the failure.
- Tabs that die without saying goodbye are forgotten by the worker: every tab sends a heartbeat,
  and the worker drops one that has been silent for three minutes.
- Tabs on different protocol versions detect each other: every tab announces its version on a
  channel no version renames, and a mismatch is reported as `PROTOCOL_VERSION_MISMATCH`.
- A worker script of another protocol version - a copied worker file from another release, or a
  cached one - is reported as `PROTOCOL_VERSION_MISMATCH`, and the tabs move to `BroadcastChannel`
  instead of staying cut off from each other with nothing reported.
- Minified ES module builds, `serial-broker/min` and `serial-broker/diagnostics/min`, for pages
  without a bundler. They use the same worker script as the readable build, and every build is
  checked against the package exports.
- An opt-in structured logger. The library writes nothing to the console uninvited.
- A read-only diagnostics entry point, `serial-broker/diagnostics`. Every tab of the origin
  reports its role, connection state, reconnect timing, pending writes, listeners and effective
  settings, and a configuration's traffic can be watched - without the observing page taking part
  in ownership. The main entry point is unchanged and still reveals nothing of the kind.
- A debugging surface, shipped as static content in `dist/debug/`: one card per configuration on
  the origin, with the tabs running it, its traffic and settings, and the action that fits -
  join, choose a device, release. It sets nothing up on its own.
- `maxTabs` limits how many tabs use a configuration at once, 1 for exclusive use. A tab beyond
  the limit shows the new status `queued` and takes over, in arrival order, when a tab releases the
  configuration, closes or crashes. A tab running a different limit reports
  `CONFIGURATION_CONFLICT` and withdraws.
- Tabs notice a worker that died - crashed, ended for memory, or terminated from
  `chrome://inspect` - because it stops answering their heartbeats. Each reports
  `BROKER_UNAVAILABLE` once and connects to a new worker, where it takes up its part again. The tab
  holding the port restates its status there, and writes lost with the old worker are handed on.
- A write reaches the device at most once, also when the tab holding the port changes while other
  tabs have not yet heard of it: the new owner recognises a request it has already accepted.
- An unplugged device keeps the status `reconnecting`, and `maxAttempts` applies to it. Only a port
  that disappears without a `disconnect` event - a revoked permission - leads to
  `awaiting-permission`.
- Errors not tied to a configuration that arrive while nothing listens for `onError` - a corrupt
  remembered configuration found by `restore()` in a fresh tab, another protocol version noticed
  while nothing was set up - are kept for the first `onError` listener.

### Changed while hardening (2026-09-13)

- `transport: 'sharedworker'` fails with `BROKER_UNAVAILABLE` where the platform has no
  `SharedWorker`, instead of silently using a `BroadcastChannel`.
- `subscribe()` rejects an event name it does not know with `INVALID_ARGUMENT`, instead of
  registering a listener that is never called.
- A tab that withdrew over a different `maxTabs` rejects `send()` at once with
  `CONFIGURATION_CONFLICT`, instead of letting the write wait for its deadline.
- Errors thrown at the public surface carry the time they arose instead of `0`, and every
  `INVALID_ARGUMENT` has the same context: `argumentName`, `expected`, `actualType`,
  `actualValue`.
- Connection attempts are numbered from one alike in errors, log records and diagnostics.
- New log records: `supervisor.teardown-failed`, `client.dispose-failed`,
  `transport.dispose-failed`, and the `transport.*` records of a worker that stopped answering.
- Building and testing need Node 22.13 or later, as the toolchain does. This is declared in
  `devEngines`, so installing the package in an application is not restricted.
- A clean handover no longer fails a write that succeeded, or writes one twice: messages carry the
  term of holding the port, and a started write is failed with `OWNER_LOST_DURING_WRITE` only once
  that term has provably ended (ADR-0026). After a crash this takes up to one second. Other tabs
  show `reconnecting` only once the departing tab has closed the port.
- A `SecurityError` from opening the port, or ports that cannot be listed, end in `failed` at once
  instead of being retried forever or showing `awaiting-permission`; logged as
  `supervisor.gave-up`.
- `release()` forgets a remembered configuration only when no other tab still runs it with
  `persist: true` (ADR-0027); each such tab holds a shared Web Lock for it.
- A tab that meets a worker script of another protocol version and cannot fall back reports it
  once and stops starting new workers, instead of restarting one every 45 seconds.
- `isSupported()` needs a `SharedWorker` or a `BroadcastChannel`, no longer both.
- The published type definitions no longer need `@types/w3c-web-serial` installed; the build
  checks them in a project without it.
- `configure()`, `release()` and `releaseAll()` reject invalid options with `INVALID_ARGUMENT` and
  read them once, when called.
- `release()`, `releaseAll()` and `dispose()` called while a `dispose()` is under way resolve only
  once its ports are closed.
- Clearer remediation for `PROTOCOL_VERSION_MISMATCH`, `BROKER_UNAVAILABLE`, `NOT_CONNECTED` and
  `OWNER_LOST_DURING_WRITE`.
- The debugging surface asks before using a worker URL that only a link names, never uses one of
  another origin, and does not start when framed by another origin.

### Changed while hardening (2026-09-14)

- A message on the bus beyond a documented limit is dropped and logged once per tab as
  `transport.limit-exceeded`; every limit is listed in `SECURITY.md`. Accepted messages are rebuilt
  from their declared fields, so nothing a sender adds travels further.
- The worker holds each port to the identity its `hello` named: it refuses messages before `hello`
  and messages sent under another identity, and a port saying `hello` as an existing tab no longer
  takes that tab's messages or ends its participation.
- A version announcement whose version is not a positive safe integer is ignored.
- `SECURITY.md` says precisely what a script of the same origin can and cannot make serial-broker do.
- A write that rejects with `WRITE_TIMEOUT` and `started: false` is never written afterwards: the tab
  holding the port does not begin a write that waited `writeTimeoutMs` there
  (`supervisor.write-expired`).
- A tab resuming from being frozen, or from sleep, no longer fails a write that succeeded or writes
  one twice: a deadline that fires late first lets the messages that arrived meanwhile be heard.
- A large write is handed to the device one chunk at a time, instead of preparing every chunk first.
- A second `release()` while one is under way resolves only once the port is closed. A listener that
  releases from `onSend` or during `setup()` no longer fails a write or keeps the configuration
  remembered, and a diagnostics watcher removed during a delivery hears nothing more.
- A tab keeps at most 8 reported peer versions and 16 unheard errors, logged once as
  `client.peer-versions-limit` and `client.unheard-errors-dropped`.
- The function `subscribe()` returns removes only its own registration: called after the listener
  was removed and registered again, it leaves the new registration in place.
- In a context with an opaque origin - a sandboxed iframe without `allow-same-origin` - building the
  library raises `WEB_LOCKS_UNAVAILABLE` and `isSupported()` returns `false`, instead of the status
  staying `idle` with nothing said.
- `send()` rejects a payload over 16 MiB with `INVALID_ARGUMENT` in every tab, instead of the write
  timing out when another tab holds the port.
- Errors raised by the facade's own checks carry the time they arose.
- `BROKER_UNAVAILABLE` for a worker that stopped answering has `isRetryable: true`: the tabs replace
  the worker on their own.

### Notes

- Wire protocol version: **7** (8 since the hardening after this release, see above). Version 1 was
  never released; 2 added the diagnostics request and
  report, 3 the broker's `welcome`, 4 the `heartbeat`, and 5 has the broker answer every heartbeat
  with a `welcome` and freezes the shape of `hello` and `welcome` for every later version
  ([ADR-0024](./docs/adr/0024-keep-the-worker-handshake-version-independent.md)), and 6 adds the tab limit to the `status` message ([ADR-0025](./docs/adr/0025-limit-the-tabs-using-a-configuration.md)), and 7 names the term of holding the port in ownership, write and status messages ([ADR-0026](./docs/adr/0026-attribute-messages-to-a-term-of-holding-the-port.md)).
- Remembered configurations are stored under a key with a version of its own,
  `serial-broker/configurations/v1`, so a protocol change no longer discards them. Configurations
  remembered under the earlier, protocol-versioned keys are moved there when they are first read.
