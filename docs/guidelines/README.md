# Engineering Guidelines

These documents are binding for every change in this repository. They are derived from
publicly documented practice at Mozilla (MDN writing style, Firefox coding style),
Google (TypeScript / JavaScript style guides, engineering practices, API design tips)
and the W3C/WHATWG specification conventions, reduced to what actually serves a small,
focused browser library.

| Document | Scope |
| --- | --- |
| [Coding Style](./coding-style.md) | Formatting, naming, file layout, imports |
| [TypeScript](./typescript.md) | Type-system rules, public type surface |
| [Defensive Programming](./defensive-programming.md) | Validation, invariants, trust boundaries |
| [Error Handling](./error-handling.md) | Error model, codes, reporting, logging |
| [API Design](./api-design.md) | Rules for the public surface and its evolution |
| [Testing](./testing.md) | Test levels, naming, coverage gates, determinism |
| [Documentation](./documentation.md) | TSDoc, README, ADRs, changelog, terminology |
| [Git Workflow](./git-workflow.md) | Branches, commits, versioning, releases |
| [Review Checklist](./review-checklist.md) | What a reviewer verifies before approving |

## The three rules that outrank all others

1. **Correctness over convenience.** A concurrency library that is "usually right" is wrong.
   Every state transition must be explainable from the code alone.
2. **Nothing leaks.** Internal mechanics (master election, worker protocol, reconnect state
   machines) are never observable through the public API. See [API Design](./api-design.md).
3. **No silent failure.** Every error path either surfaces through the documented error
   channel or is impossible by construction. `catch {}` without a comment justifying it is a
   review blocker.

## Precedence

If a guideline conflicts with an [ADR](../adr/README.md), the ADR wins and the guideline is
amended in the same change. If a guideline conflicts with the toolchain configuration
(`eslint.config.js`, `tsconfig.json`), the toolchain wins and the guideline is amended —
tooling is the executable form of these documents.
