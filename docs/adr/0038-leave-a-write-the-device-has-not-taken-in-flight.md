# ADR-0038: Leave a write the device has not taken in flight

- **Status:** Superseded by [ADR-0013](./0013-write-ordering-and-delivery-semantics.md) (2026-09-15)
- **Date:** 2026-09-15

**Decision, as first recorded:** A chunk that outlives `writeTimeoutMs` fails its caller with
`WRITE_TIMEOUT` but stays in flight, and no longer ends the connection.

**Trail:** Folded into ADR-0013 on 2026-09-15.
