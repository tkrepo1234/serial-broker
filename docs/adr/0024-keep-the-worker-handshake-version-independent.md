# ADR-0024: Keep the handshake with the worker readable by every protocol version

- **Status:** Superseded by [ADR-0008](./0008-wire-protocol-and-versioning.md) (2026-09-15)
- **Date:** 2026-09-13

**Decision, as first recorded:** Freeze `hello` and `welcome` so that a worker of any protocol
version answers a tab, and a tab that hears another version reports it and falls back.

**Trail:** Amended 2026-09-14 (give up on a worker of another version where nothing falls back) and
2026-09-15 (no heartbeats); folded into ADR-0008 on 2026-09-15.
