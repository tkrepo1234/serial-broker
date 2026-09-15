# ADR-0002: Wrap the transport only, no protocol layer

- **Status:** Accepted; its "no buffering, no timing heuristics" is superseded by
  [ADR-0039](./0039-collect-received-bytes-until-the-line-is-quiet.md)
- **Date:** 2026-09-12

## Context

Serial devices speak wildly different protocols: line-oriented ASCII terminated by `\r\n`,
STX/ETX-framed binary with a BCC, Modbus RTU with a 3.5-character silent interval, fixed
length records, length-prefixed frames. Any framing rule this library picked would be wrong
for most devices, and a framing rule that is _configurable enough_ to fit all of them is a
second product.

Reading from a serial port yields arbitrary chunks: one logical message can arrive in five
`read()` results, and five messages can arrive in one.

## Decision

This library wraps the transport and nothing else. It delivers byte chunks exactly as the
Web Serial API produces them, with no buffering, no framing, no timing heuristics, no
request/response correlation and no interpretation.

Protocol handling belongs in a separate layer built on top of this one, consuming
`onReceive` and calling `send`.

## Alternatives considered

- **Configurable delimiter-based framing.** Attractive for the common line-oriented case, but
  it fails for binary protocols with escaping, it needs timeouts to handle partial frames, and
  once a delimiter option exists, the requests for checksums, escaping and length prefixes
  follow immediately. Rejected as scope creep that compromises the core guarantee.
- **A pluggable codec interface in this library.** Would mean shipping a plugin contract,
  versioning it, and running application code inside the owner tab's read loop where an
  exception can stall the port. Rejected: the same composition is achievable outside the
  library with strictly less coupling.
- **Optional "line mode".** The 80% case, but it splits the delivery semantics in two and
  doubles the test matrix for every failover scenario. Rejected; a ten-line helper on top of
  `onReceive` does it without touching the transport.

## Consequences

### Positive

- The delivery contract is trivially stated and trivially testable: bytes in, bytes out, in
  order, exactly once.
- No release of this library can break a device by changing framing behaviour.

### Negative

- Every consumer writes or imports its own framing. Mitigated by documenting the two common
  patterns in the README and shipping the demo with a line-assembler example.

## Verification

`src/` contains no buffering of received data beyond the single chunk in flight; the scenario
matrix asserts chunk-for-chunk delivery.
