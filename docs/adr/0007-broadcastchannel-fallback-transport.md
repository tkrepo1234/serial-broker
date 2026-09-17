# ADR-0007: Fall back to BroadcastChannel when SharedWorker is unavailable

- **Status:** Superseded by [ADR-0006](./0006-sharedworker-as-message-broker.md) (2026-09-15)
- **Date:** 2026-09-12

**Decision, as first recorded:** When `SharedWorker` is missing or its construction throws, carry
the bus over `BroadcastChannel`, each tab applying only the messages addressed to it.
