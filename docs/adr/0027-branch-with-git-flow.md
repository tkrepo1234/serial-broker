# ADR-0027: Branch with git-flow

- **Status:** Accepted

## Context

The library is installed on production stations, where what runs is a released version and
nothing else. A reader of the repository, a station's integrator and the published documentation
all need one answer to "what is released?", and work on the next version must not blur it.
Releases are rare and deliberate: each one is checked by hand against hardware
(`docs/manual-test-plan.md`) before its tag.

## Decision

The repository follows git-flow. `main` holds released versions only, each commit a release with
its tag; `develop` holds the next version and is always green. Work happens on `feature/` branches
taken from `develop`; a version is prepared on a `release/` branch and an urgent fix to a released
version on a `hotfix/` branch, and both end in a merge commit on `main`, a tag, and a merge back
into `develop`. The rules and names are in `docs/guidelines/git-workflow.md`, the release steps in
`CONTRIBUTING.md`.

CI runs on `develop`, `main`, `release/**`, `hotfix/**` and every pull request. The tag starts the
release workflow; the push to `main` publishes the documentation, so the published documentation
is that of the released version.

## Alternatives considered

- **Trunk-based development: one branch, releases as tags on it.** Less ceremony, and right for a
  service deployed continuously. Here the default view of the repository and the published
  documentation would describe unreleased behaviour between two tags, which is exactly what an
  integrator must not read as installed.
- **GitHub flow: `main` plus feature branches.** The same objection; it also has no place for
  the last fixes of a version while work on the next one goes on.
- **Release branches kept for ever, one per minor version.** Needed once several versions are
  maintained side by side. One version is maintained; a `hotfix/` branch covers it.

## Consequences

### Positive

- `main` answers "what is released?" by itself, and so does the documentation site.
- A version's last fixes and the next version's work do not wait for each other.

### Negative

- Two merges per release instead of a tag, and a merge back that must not be forgotten.
- A contributor has to know that pull requests go to `develop`.

### Risks and mitigations

- **A release merged into `main` and not back into `develop`** loses its version number and
  changelog section on the next release. The release steps end with the merge back, and
  `release:check` fails on a changelog without a section for the version.

## Verification

`.github/workflows/ci.yml` names the branches; `.github/workflows/pages.yml` publishes from `main`
only; `.github/workflows/release.yml` runs on a tag.
