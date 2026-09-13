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
  Android, functionally equivalent to the default.
- An opt-in structured logger. The library writes nothing to the console uninvited.
- A read-only diagnostics entry point, `serial-broker/diagnostics`. Every tab of the origin
  reports its role, connection state, reconnect timing, pending writes, listeners and effective
  settings, and a configuration's traffic can be watched - without the observing page taking part
  in ownership. The main entry point is unchanged and still reveals nothing of the kind.
- A debugging surface, shipped as static content in `dist/debug/`: one card per configuration on
  the origin, with the tabs running it, its traffic and settings, and the action that fits -
  join, choose a device, release. It sets nothing up on its own.

### Notes

- Wire protocol version: **2**. Version 1 was never released; 2 adds the diagnostics request and
  report.
