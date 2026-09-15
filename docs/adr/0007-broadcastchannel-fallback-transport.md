# ADR-0007: Fall back to BroadcastChannel when SharedWorker is unavailable

- **Status:** Superseded by [ADR-0006](./0006-sharedworker-as-message-broker.md) (2026-09-15)
- **Date:** 2026-09-12

**Decision, as first recorded:** When `SharedWorker` is missing or its construction throws, carry
the bus over `BroadcastChannel`, each tab applying only the messages addressed to it.

**Trail:** Amended 2026-09-13 (fall back when the worker script fails to load, replaying what was
sent) and 2026-09-15 (restate instead of replaying); folded into ADR-0006 on 2026-09-15.
