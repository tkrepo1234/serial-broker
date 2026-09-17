# ADR-0023: Announce the protocol version on an unversioned channel

- **Status:** Superseded by [ADR-0008](./0008-wire-protocol-and-versioning.md) (2026-09-15)
- **Date:** 2026-09-13

**Decision, as first recorded:** Every tab announces its protocol version on the frozen, unversioned
channel `serial-broker/announcements`, so a mixed deployment is reported as
`PROTOCOL_VERSION_MISMATCH`.
