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
- The package requires Node 22.13 or later to build and test, as the toolchain does.

### Notes

- Wire protocol version: **6**. Version 1 was never released; 2 added the diagnostics request and
  report, 3 the broker's `welcome`, 4 the `heartbeat`, and 5 has the broker answer every heartbeat
  with a `welcome` and freezes the shape of `hello` and `welcome` for every later version
  ([ADR-0024](./docs/adr/0024-keep-the-worker-handshake-version-independent.md)), and 6 adds the tab limit to the `status` message ([ADR-0025](./docs/adr/0025-limit-the-tabs-using-a-configuration.md)).
- Remembered configurations are stored under a key with a version of its own,
  `serial-broker/configurations/v1`, so a protocol change no longer discards them. Configurations
  remembered under the earlier, protocol-versioned keys are moved there when they are first read.
