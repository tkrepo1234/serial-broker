# ADR-0022: Version stored configurations separately from the protocol

- **Status:** Superseded by [ADR-0033](./0033-one-storage-key-per-configuration.md) (2026-09-15)
- **Date:** 2026-09-13

**Decision, as first recorded:** Store configurations under a key carrying `STORAGE_SCHEMA_VERSION`
rather than the protocol version, moving entries over from the protocol-versioned keys.

**Trail:** The move was dropped by ADR-0033 on 2026-09-14; the storage version rule folded into
ADR-0033 on 2026-09-15. Nothing is migrated any more.
