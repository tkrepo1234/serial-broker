# ADR-0032: Measure durations on a monotonic clock, timestamp events on the wall clock

- **Status:** Superseded by [ADR-0014](./0014-dependency-injection-of-the-environment.md) (2026-09-15)
- **Date:** 2026-09-14

**Decision, as first recorded:** `Clock` gains `monotonicNow()` for every duration; `now()` stays
the wall clock for every moment that is shown or sent.
