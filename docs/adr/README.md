# Architecture Decision Records

Every architectural decision in this library is recorded here, using a
[MADR](https://adr.github.io/madr/)-derived format ([template](./0000-template.md)).

**Records are immutable once accepted.** A decision that changes is superseded by a new
record; the old one keeps its number and gains a `Superseded by` status. Code that exists
because of a decision references it in a comment (`// See ADR-0005.`).

| #                                                                     | Title                                                                               | Status                      |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------- |
| [0001](./0001-record-architecture-decisions.md)                       | Record architecture decisions                                                       | Accepted                    |
| [0002](./0002-scope-transport-only.md)                                | Wrap the transport only, no protocol layer                                          | Accepted                    |
| [0003](./0003-typescript-and-toolchain.md)                            | TypeScript, Vitest, tsup, ESLint and Prettier                                       | Accepted                    |
| [0004](./0004-port-ownership-lives-in-a-window.md)                    | The physical port is owned by a window, not by the worker                           | Accepted                    |
| [0005](./0005-owner-election-via-web-locks.md)                        | Elect the port owner with the Web Locks API                                         | Accepted                    |
| [0006](./0006-sharedworker-as-message-broker.md)                      | Use a SharedWorker as the message broker                                            | Accepted                    |
| [0007](./0007-broadcastchannel-fallback-transport.md)                 | Fall back to BroadcastChannel when SharedWorker is unavailable                      | Amended by 0024             |
| [0008](./0008-wire-protocol-and-versioning.md)                        | Version the wire protocol independently                                             | Amended by 0023, 0024       |
| [0009](./0009-device-identity-and-permission-persistence.md)          | Identify devices by USB IDs, persist configuration, rely on browser permission      | Amended by 0016, 0022, 0033 |
| [0010](./0010-reconnect-supervision-and-backoff.md)                   | Supervise the connection with bounded exponential backoff                           | Accepted                    |
| [0011](./0011-encapsulation-boundary.md)                              | Expose nothing about the coordination mechanism                                     | Amended by 0018, 0025       |
| [0012](./0012-error-model.md)                                         | One error type, stable codes, mandatory remediation                                 | Accepted                    |
| [0013](./0013-write-ordering-and-delivery-semantics.md)               | Per-participant write ordering with at-most-once delivery                           | Amended by 0026             |
| [0014](./0014-dependency-injection-of-the-environment.md)             | Inject the browser environment for testability                                      | Amended by 0032             |
| [0015](./0015-text-and-binary-payloads.md)                            | Deliver bytes, offer text as a configured convenience                               | Accepted                    |
| [0016](./0016-non-usb-devices.md)                                     | Support ports that are not USB devices                                              | Accepted                    |
| [0017](./0017-usbip-device-emulator.md)                               | Emulate a USB serial device over USB/IP for testing without hardware                | Accepted                    |
| [0018](./0018-diagnostics-observer.md)                                | Expose coordination internals to operators through a diagnostics observer           | Accepted                    |
| [0019](./0019-ship-the-debugging-surface.md)                          | Ship the debugging surface in the package, as static content                        | Accepted                    |
| [0020](./0020-documentation-toolchain.md)                             | Build the developer documentation with Sphinx, MyST and a TSDoc-generated reference | Accepted                    |
| [0021](./0021-forget-silent-participants.md)                          | Forget tabs that stop sending heartbeats                                            | Accepted                    |
| [0022](./0022-version-stored-configurations-separately.md)            | Version stored configurations separately from the protocol                          | Amended by 0027, 0033       |
| [0023](./0023-announce-the-protocol-version.md)                       | Announce the protocol version on an unversioned channel                             | Accepted                    |
| [0024](./0024-keep-the-worker-handshake-version-independent.md)       | Keep the handshake with the worker readable by every protocol version               | Accepted                    |
| [0025](./0025-limit-the-tabs-using-a-configuration.md)                | Limit how many tabs use a configuration at once                                     | Accepted                    |
| [0026](./0026-attribute-messages-to-a-term-of-holding-the-port.md)    | Attribute ownership, write and status messages to a term of holding the port        | Accepted                    |
| [0027](./0027-keep-a-remembered-configuration-while-a-tab-runs-it.md) | Keep a remembered configuration while any tab runs it                               | Amended by 0033             |
| [0032](./0032-measure-durations-on-a-monotonic-clock.md)              | Measure durations on a monotonic clock, timestamp events on the wall clock          | Accepted                    |
| [0033](./0033-one-storage-key-per-configuration.md)                   | One storage key per configuration, with an index of the names                       | Accepted                    |
