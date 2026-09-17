# ADR-0034: Start the debugging surface from a chosen port, under its own policy

- **Status:** Superseded by [ADR-0019](./0019-ship-the-debugging-surface.md) (2026-09-15)
- **Date:** 2026-09-14

**Decision, as first recorded:** The debugging surface derives a configuration from the port chosen
in an unfiltered picker, and carries a strict `Content-Security-Policy` of its own.
