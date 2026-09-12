# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-12
- **Deciders:** Library architecture

## Context

This library coordinates a single physical resource across an unbounded number of browser
contexts. Most of its code exists to handle situations that are invisible in the happy path:
a tab dying mid-write, a lock changing hands, a device disappearing. Six months from now the
reason a particular `await` sits where it does will not be recoverable from the diff.

## Decision

We record every architectural decision as a numbered Architecture Decision Record in
`docs/adr/`, using a MADR-derived template. Records are immutable once accepted; a changed
decision is superseded by a new record. Code that exists because of a decision cites it.

## Alternatives considered

- **A single `ARCHITECTURE.md`.** Cheaper to write, but it describes the current state and
  silently loses the rejected alternatives — exactly the information that prevents someone
  re-litigating a decision. We keep `docs/architecture.md` as well, but for *how it works*,
  not *why it was chosen*.
- **Decisions in commit messages.** Not discoverable. Nobody greps a year of history before
  changing the election mechanism.
- **A wiki.** Drifts from the code, cannot be reviewed in the same pull request as the change
  it justifies.

## Consequences

### Positive
- Rejected options survive, so the same debate is not repeated.
- An ADR is reviewable alongside the code it governs.

### Negative
- Writing them costs time, and a stale ADR is worse than none. Mitigated by the immutability
  rule: ADRs are never "updated", only superseded, so they cannot drift into half-truth.

## Verification

`docs/adr/README.md` lists every record; the review checklist requires an ADR for
architectural changes.
