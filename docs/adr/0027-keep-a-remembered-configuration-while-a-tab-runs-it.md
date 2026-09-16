# ADR-0027: Keep a remembered configuration while any tab runs it

- **Status:** Superseded by [ADR-0033](./0033-one-storage-key-per-configuration.md) (2026-09-15)
- **Date:** 2026-09-14

**Decision, as first recorded:** Every tab running a remembered configuration holds a shared Web
Lock, and the entry is forgotten only when no tab holds it.

**Trail:** Lock moved to storage version 2 by ADR-0033 (2026-09-14); folded into ADR-0033 on
2026-09-15.

**History:**

- 2026-09-16: The default was reversed in ADR-0033. `release(name)` forgets nothing - a disconnect
  is not a deletion, and the application decides when something is forgotten - and
  `release(name, { forget: true })` asks for it. The rule this record stated still governs that
  path: a tab must not delete an entry another tab still runs with `remember: true`. Every release
  lets this tab's shared hold go, because the tab has stopped running the configuration; only the
  `forget` path then takes the lock exclusively.
