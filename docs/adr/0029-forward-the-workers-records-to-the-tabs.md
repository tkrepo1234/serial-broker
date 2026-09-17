# ADR-0029: Forward the worker's warnings to the tabs that are connected to it

- **Status:** Superseded by [ADR-0018](./0018-diagnostics-observer.md) (2026-09-15)
- **Date:** 2026-09-14

**Decision, as first recorded:** The worker sends its `warn` and `error` records to the connected
tabs as `worker-log`, and each tab logs them as the worker's events, within a budget of eight a
minute.
