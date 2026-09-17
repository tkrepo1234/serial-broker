# ADR-0026: Attribute ownership, write and status messages to a term of holding the port

- **Status:** Superseded by [ADR-0030](./0030-hold-a-web-lock-for-every-term-of-holding-the-port.md) (2026-09-15)
- **Date:** 2026-09-14

**Decision, as first recorded:** Give every term of holding the port an identifier, address writes
to a term, and end a succeeded term at its `owner-released` or after a one-second grace period.
