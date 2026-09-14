# Changelog

All notable changes to this project are documented here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. This project follows
[Semantic Versioning](https://semver.org/); before 1.0, breaking changes bump the minor.

The **wire protocol version** is tracked separately from the package version and is noted
explicitly whenever it changes, because tabs running different protocol versions do not
coordinate with each other. See
[ADR-0008](./docs/adr/0008-wire-protocol-and-versioning.md).

## [Unreleased]

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

### Notes

- Wire protocol version: **7**. Version 1 was never released; 2 added the diagnostics request and
  report, 3 the broker's `welcome`, 4 the `heartbeat`, and 5 has the broker answer every heartbeat
  with a `welcome` and freezes the shape of `hello` and `welcome` for every later version
  ([ADR-0024](./docs/adr/0024-keep-the-worker-handshake-version-independent.md)), and 6 adds the tab limit to the `status` message ([ADR-0025](./docs/adr/0025-limit-the-tabs-using-a-configuration.md)), and 7 names the term of holding the port in ownership, write and status messages ([ADR-0026](./docs/adr/0026-attribute-messages-to-a-term-of-holding-the-port.md)).
- Remembered configurations are stored under a key with a version of its own,
  `serial-broker/configurations/v1`, so a protocol change no longer discards them. Configurations
  remembered under the earlier, protocol-versioned keys are moved there when they are first read.
