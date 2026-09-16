# Architecture Decision Records

Every architectural decision in this library is recorded here, using a
[MADR](https://adr.github.io/madr/)-derived format ([template](./0000-template.md)).

**One current record per decision** ([ADR-0001](./0001-record-architecture-decisions.md)). A decision
that changes is folded into its current record, which gains a one-line history entry. A record whose
decision was replaced, merged or retired keeps its number as a short stub pointing forward, so every
citation in code (`// See ADR-0005.`) still resolves. How the library works, rather than why, is the
Internals chapter of the developer documentation (`docs/site/internals.md`).

## Current decisions

| #                                                                        | Decision                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [0001](./0001-record-architecture-decisions.md)                          | Record architecture decisions, one current record per decision                      |
| [0002](./0002-scope-transport-only.md)                                   | Wrap the transport only; collect received bytes until the line is quiet             |
| [0003](./0003-typescript-and-toolchain.md)                               | TypeScript, Vitest, tsup, ESLint and Prettier                                       |
| [0004](./0004-port-ownership-lives-in-a-window.md)                       | The physical port is owned by a window, not by the worker                           |
| [0005](./0005-owner-election-via-web-locks.md)                           | Elect the port owner with the Web Locks API                                         |
| [0006](./0006-sharedworker-as-message-broker.md)                         | A SharedWorker broker routing to all participants, with a BroadcastChannel fallback |
| [0008](./0008-wire-protocol-and-versioning.md)                           | Version the wire protocol; announce it; freeze the worker handshake                 |
| [0010](./0010-reconnect-supervision-and-backoff.md)                      | Supervise the connection with bounded exponential backoff                           |
| [0011](./0011-encapsulation-boundary.md)                                 | Expose nothing about the coordination mechanism                                     |
| [0012](./0012-error-model.md)                                            | One error type, stable codes, mandatory remediation                                 |
| [0013](./0013-write-ordering-and-delivery-semantics.md)                  | Per-participant write ordering with at-most-once delivery                           |
| [0014](./0014-dependency-injection-of-the-environment.md)                | Inject the browser environment, with a monotonic and a wall clock                   |
| [0015](./0015-text-and-binary-payloads.md)                               | Deliver bytes, offer text as a configured convenience                               |
| [0018](./0018-diagnostics-observer.md)                                   | Expose coordination internals to operators through a diagnostics observer           |
| [0019](./0019-ship-the-debugging-surface.md)                             | Ship the debugging surface in the package, as static content, under its own policy  |
| [0020](./0020-documentation-toolchain.md)                                | Build the developer documentation with Sphinx, MyST and a TSDoc-generated reference |
| [0025](./0025-limit-the-tabs-using-a-configuration.md)                   | Limit how many tabs use a configuration at once                                     |
| [0030](./0030-hold-a-web-lock-for-every-term-of-holding-the-port.md)     | Hold a Web Lock for every term of holding the port                                  |
| [0031](./0031-bound-and-rate-limit-what-the-bus-can-cost-a-tab.md)       | Bound and rate-limit what the bus can cost a tab                                    |
| [0033](./0033-one-storage-key-per-configuration.md)                      | Remembered configurations: one storage key each, kept while any tab runs them       |
| [0035](./0035-browser-tests-with-playwright.md)                          | Test in a real browser, against an emulated device and against real hardware        |
| [0036](./0036-take-the-device-identity-from-the-chosen-port.md)          | Device identity, permission and auto mode: the port the user chooses                |
| [0037](./0037-measure-performance-against-expectations-written-first.md) | Measure performance against expectations written first                              |
| [0041](./0041-tell-liveness-through-web-locks.md)                        | Tell who is still there through Web Locks, not heartbeats                           |
| [0042](./0042-keep-the-toolchains-configuration-in-config.md)            | Keep the toolchain's configuration in config/                                       |

## Superseded

| #                                                                     | Was                                                      | Now in |
| --------------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| [0007](./0007-broadcastchannel-fallback-transport.md)                 | BroadcastChannel fallback                                | 0006   |
| [0009](./0009-device-identity-and-permission-persistence.md)          | USB IDs, persisted configuration, browser permission     | 0036   |
| [0016](./0016-non-usb-devices.md)                                     | Ports that are not USB devices                           | 0036   |
| [0017](./0017-usbip-device-emulator.md)                               | USB/IP device emulator                                   | 0035   |
| [0021](./0021-forget-silent-participants.md)                          | Heartbeats                                               | 0041   |
| [0022](./0022-version-stored-configurations-separately.md)            | A storage version, with migration                        | 0033   |
| [0023](./0023-announce-the-protocol-version.md)                       | Protocol version announcement                            | 0008   |
| [0024](./0024-keep-the-worker-handshake-version-independent.md)       | Frozen worker handshake                                  | 0008   |
| [0026](./0026-attribute-messages-to-a-term-of-holding-the-port.md)    | Terms with a grace period                                | 0030   |
| [0027](./0027-keep-a-remembered-configuration-while-a-tab-runs-it.md) | Remembered while any tab runs it                         | 0033   |
| [0028](./0028-bind-an-identity-on-the-worker-to-a-secret.md)          | Identity secret on the worker (removed)                  | 0006   |
| [0029](./0029-forward-the-workers-records-to-the-tabs.md)             | The worker's warnings forwarded to the tabs              | 0018   |
| [0032](./0032-measure-durations-on-a-monotonic-clock.md)              | Monotonic clock for durations                            | 0014   |
| [0034](./0034-start-the-debugging-surface-from-a-chosen-port.md)      | Debugging surface: chosen port (retired), its own policy | 0019   |
| [0038](./0038-leave-a-write-the-device-has-not-taken-in-flight.md)    | A write the device has not taken stays in flight         | 0013   |
| [0039](./0039-collect-received-bytes-until-the-line-is-quiet.md)      | Collect received bytes until the line is quiet           | 0002   |
| [0040](./0040-route-to-all-participants-drop-the-identity-secret.md)  | Route to all participants, drop the identity secret      | 0006   |
