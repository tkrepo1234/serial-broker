# ADR-0039: Collect received bytes until the line is quiet

- **Status:** Superseded by [ADR-0002](./0002-scope-transport-only.md) (2026-09-15)
- **Date:** 2026-09-15

**Decision, as first recorded:** The tab holding the port collects received chunks and delivers them
once the line has been quiet for `receive.idleMs`, instead of chunk by chunk.
