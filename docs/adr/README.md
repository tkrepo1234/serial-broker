# Architecture Decision Records

Every architectural decision in this library is recorded here, using a
[MADR](https://adr.github.io/madr/)-derived format ([template](./0000-template.md)).

**One current record per decision** ([ADR-0001](./0001-record-architecture-decisions.md)): each
states the decision as it stands, with its reasons and the alternatives that lose to it. How the
library works, rather than why, is the Internals chapter of the developer documentation
(`docs/site/internals.md`).

## Current decisions

| #                                                                        | Decision                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| [0001](./0001-record-architecture-decisions.md)                          | Record architecture decisions, one current record per decision                      |
| [0002](./0002-scope-transport-only.md)                                   | Wrap the transport only; collect received bytes until the line is quiet             |
| [0003](./0003-typescript-and-toolchain.md)                               | TypeScript, Vitest, tsup, ESLint and Prettier                                       |
| [0004](./0004-port-ownership-lives-in-a-window.md)                       | The physical port is owned by a window, not by the worker                           |
| [0005](./0005-owner-election-via-web-locks.md)                           | Elect the port owner with the Web Locks API                                         |
| [0006](./0006-sharedworker-as-message-broker.md)                         | A SharedWorker broker routing to all participants, with a BroadcastChannel fallback |
| [0007](./0007-wire-protocol-and-versioning.md)                           | Version the wire protocol; announce it; freeze the worker handshake                 |
| [0008](./0008-reconnect-supervision-and-backoff.md)                      | Supervise the connection with bounded exponential backoff                           |
| [0009](./0009-encapsulation-boundary.md)                                 | Expose nothing about the coordination mechanism                                     |
| [0010](./0010-error-model.md)                                            | One error type, stable codes, mandatory remediation                                 |
| [0011](./0011-write-ordering-and-delivery-semantics.md)                  | Per-participant write ordering with at-most-once delivery                           |
| [0012](./0012-dependency-injection-of-the-environment.md)                | Inject the browser environment, with a monotonic and a wall clock                   |
| [0013](./0013-text-and-binary-payloads.md)                               | Deliver bytes, offer text as a configured convenience                               |
| [0014](./0014-diagnostics-observer.md)                                   | Expose coordination internals to operators through a diagnostics observer           |
| [0015](./0015-ship-the-debugging-surface.md)                             | Ship the debugging surface in the package, as static content, under its own policy  |
| [0016](./0016-documentation-toolchain.md)                                | Build the developer documentation with Sphinx, MyST and a TSDoc-generated reference |
| [0017](./0017-limit-the-tabs-using-a-configuration.md)                   | Limit how many tabs use a configuration at once                                     |
| [0018](./0018-hold-a-web-lock-for-every-term-of-holding-the-port.md)     | Hold a Web Lock for every term of holding the port                                  |
| [0019](./0019-bound-and-rate-limit-what-the-bus-can-cost-a-tab.md)       | Bound and rate-limit what the bus can cost a tab                                    |
| [0020](./0020-one-storage-key-per-configuration.md)                      | Remembered configurations: one storage key each, kept while any tab runs them       |
| [0021](./0021-browser-tests-with-playwright.md)                          | Test in a real browser, against an emulated device and against real hardware        |
| [0022](./0022-take-the-device-identity-from-the-chosen-port.md)          | Device identity, permission and auto mode: the port the user chooses                |
| [0023](./0023-measure-performance-against-expectations-written-first.md) | Measure performance against expectations written first                              |
| [0024](./0024-tell-liveness-through-web-locks.md)                        | Tell who is still there through Web Locks, not heartbeats                           |
| [0025](./0025-keep-the-toolchains-configuration-in-config.md)            | Keep the toolchain's configuration in config/                                       |
| [0026](./0026-a-classic-script-build-and-published-names.md)             | Ship a classic script build on one global; name published files after the package   |
| [0027](./0027-branch-with-git-flow.md)                                   | Branch with git-flow                                                                |
