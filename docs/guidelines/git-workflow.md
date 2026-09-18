# Git Workflow

## Branches

The repository follows git-flow (ADR-0027). Two branches live for ever:

| Branch    | What it holds                                                                  |
| --------- | ------------------------------------------------------------------------------ |
| `main`    | Released versions only. Every commit on it is a release and carries its tag.   |
| `develop` | The next version. It type-checks, lints, passes every test and builds, always. |

Three kinds of branch come and go:

| Branch              | From      | Into                 | For                                                        |
| ------------------- | --------- | -------------------- | ---------------------------------------------------------- |
| `feature/<name>`    | `develop` | `develop`            | Any change: a feature, a fix, documentation, tooling.      |
| `release/<version>` | `develop` | `main` and `develop` | The version number, the changelog section, last fixes.     |
| `hotfix/<version>`  | `main`    | `main` and `develop` | A fix to a released version that cannot wait for the next. |

- Names are lower case with hyphens: `feature/owner-failover`, `release/0.2.0`, `hotfix/0.2.1`.
- Every merge into `develop` and `main` is a merge commit (`git merge --no-ff`), so a branch stays
  visible as one unit and can be reverted as one.
- Nothing is committed to `main` directly, and nothing reaches it that has not been on a
  `release/` or `hotfix/` branch with CI green.
- A branch is deleted once it is merged.

## Commits

The subject is one imperative sentence saying what the commit does for the library, in plain
words — "Keep writes at most once at the port", not "fix(client): dedupe". The changelog is written
by hand, from what changed for users, so nothing is derived from a prefix:

```
<imperative summary, <= 72 chars, no trailing period>

<body: why, not what. Wrapped at 80 columns. Refs: ADR-0005>

<trailers>
```

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

## Releases

A release is a `release/<version>` branch that ends in a tag on `main`; the steps are in
[CONTRIBUTING.md](../../CONTRIBUTING.md#releasing). The tag starts the release workflow, and the
push to `main` publishes the documentation of that version.

## Definition of done

A change is done when all of these are true:

- [ ] `npm run verify` is green (type-check, lint, format check, tests, coverage gates, build).
- [ ] New behaviour has tests at the right level, including the multi-context level when it
      touches coordination.
- [ ] TSDoc updated on every touched export.
- [ ] `CHANGELOG.md` has an entry under `Unreleased` if the change is user-visible.
- [ ] An ADR exists if an architectural choice was made or reversed.
- [ ] No new `any`, no new `!`, no new disabled lint rule without a comment.
