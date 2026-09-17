# ADR-0027: Keep a remembered configuration while any tab runs it

- **Status:** Superseded by [ADR-0033](./0033-one-storage-key-per-configuration.md) (2026-09-15)
- **Date:** 2026-09-14

**Decision, as first recorded:** Every tab running a remembered configuration holds a shared Web
Lock, and the entry is forgotten only when no tab holds it.
