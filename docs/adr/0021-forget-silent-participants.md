# ADR-0021: Forget tabs that stop sending heartbeats

- **Status:** Superseded by [ADR-0041](./0041-tell-liveness-through-web-locks.md) (2026-09-15)
- **Date:** 2026-09-13

**Decision, as first recorded:** Tabs send a heartbeat every 15 seconds, the worker forgets a tab
silent for three minutes, and a tab whose heartbeats go unanswered starts a new worker.
