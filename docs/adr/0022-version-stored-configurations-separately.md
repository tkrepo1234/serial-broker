# ADR-0022: Version stored configurations separately from the protocol

- **Status:** Superseded by [ADR-0033](./0033-one-storage-key-per-configuration.md) (2026-09-15)
- **Date:** 2026-09-13

**Decision, as first recorded:** Store configurations under a key carrying `STORAGE_SCHEMA_VERSION`
rather than the protocol version, moving entries over from the protocol-versioned keys.
