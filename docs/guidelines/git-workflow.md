# Git Workflow

## Branches

`main` is always releasable: it type-checks, lints, passes every test, and builds. Work
happens on short-lived branches named `<type>/<short-description>`, e.g.
`feat/owner-failover`, `fix/write-lost-on-owner-death`, `docs/adr-reconnect`.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), because the changelog and the
version bump are derived from them:

```
<type>(<scope>): <imperative summary, <= 72 chars>

<body: why, not what. Wrapped at 100 columns.>

<footer: BREAKING CHANGE: ..., Refs: ADR-0005, Closes #12>
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`.
Scopes: `core`, `client`, `worker`, `owner`, `storage`, `protocol`, `api`, `docs`, `test`.

Rules:

- **One logical change per commit.** A commit that fixes a bug and reformats a file is split.
- The body answers _why_. The diff already shows _what_.
- A commit that changes behaviour touches tests in the same commit.
- A commit that changes the public API touches `README.md`, TSDoc and `CHANGELOG.md` in the
  same commit.
- Never commit commented-out code, `console.log`, `.only` on a test, or a TODO without an
  issue reference.

## Versioning

Strict [SemVer](https://semver.org/). The public surface is defined in
[API Design](./api-design.md).

- The **wire protocol version** is separate from the package version and lives in
  `src/protocol/version.ts`. Bumping it is always at least a minor release and is always
  accompanied by an ADR describing the federation behaviour across the boundary.
- Pre-1.0: breaking changes bump the minor. From 1.0 on, the major.

## Definition of done

A change is done when all of these are true:

- [ ] `npm run verify` is green (type-check, lint, format check, tests, coverage gates, build).
- [ ] New behaviour has tests at the right level, including the multi-context level when it
      touches coordination.
- [ ] TSDoc updated on every touched export.
- [ ] `CHANGELOG.md` has an entry under `Unreleased` if the change is user-visible.
- [ ] An ADR exists if an architectural choice was made or reversed.
- [ ] No new `any`, no new `!`, no new disabled lint rule without a comment.
