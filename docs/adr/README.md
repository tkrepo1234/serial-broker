| [0016](./0016-non-usb-devices.md) | Support ports that are not USB devices | Accepted |
| [0015](./0015-text-and-binary-payloads.md) | Deliver bytes, offer text as a configured convenience | Accepted |
| [0016](./0016-non-usb-devices.md) | Support ports that are not USB devices | Accepted |

# Architecture Decision Records

Every architectural decision in this library is recorded here, using a
[MADR](https://adr.github.io/madr/)-derived format ([template](./0000-template.md)).

**Records are immutable once accepted.** A decision that changes is superseded by a new
record; the old one keeps its number and gains a `Superseded by` status. Code that exists
because of a decision references it in a comment (`// See ADR-0005.`).

| #                                                            | Title                                                                          | Status   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ | -------- |
| [0001](./0001-record-architecture-decisions.md)              | Record architecture decisions                                                  | Accepted |
| [0002](./0002-scope-transport-only.md)                       | Wrap the transport only, no protocol layer                                     | Accepted |
| [0003](./0003-typescript-and-toolchain.md)                   | TypeScript, Vitest, tsup, ESLint, Prettier                                     | Accepted |
| [0004](./0004-port-ownership-lives-in-a-window.md)           | The physical port is owned by a window, not by the worker                      | Accepted |
| [0005](./0005-owner-election-via-web-locks.md)               | Elect the port owner with the Web Locks API                                    | Accepted |
| [0006](./0006-sharedworker-as-message-broker.md)             | Use a SharedWorker as the message broker                                       | Accepted |
| [0007](./0007-broadcastchannel-fallback-transport.md)        | Fall back to BroadcastChannel when SharedWorker is unavailable                 | Accepted |
| [0008](./0008-wire-protocol-and-versioning.md)               | Version the wire protocol independently                                        | Accepted |
| [0009](./0009-device-identity-and-permission-persistence.md) | Identify devices by USB IDs, persist configuration, rely on browser permission | Accepted |
| [0010](./0010-reconnect-supervision-and-backoff.md)          | Supervise the connection with bounded exponential backoff                      | Accepted |
| [0011](./0011-encapsulation-boundary.md)                     | Expose nothing about the coordination mechanism                                | Accepted |
| [0012](./0012-error-model.md)                                | One error type, stable codes, mandatory remediation                            | Accepted |
| [0013](./0013-write-ordering-and-delivery-semantics.md)      | Per-participant write ordering with at-most-once delivery                      | Accepted |
| [0014](./0014-dependency-injection-of-the-environment.md)    | Inject the browser environment for testability                                 | Accepted |
| [0015](./0015-text-and-binary-payloads.md)                   | Deliver bytes, offer text as a configured convenience                          | Accepted |
| [0016](./0016-non-usb-devices.md)                            | Support ports that are not USB devices                                         | Accepted |
