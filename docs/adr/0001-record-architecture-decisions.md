# ADR-0001: Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-09-12
- **Deciders:** Library architecture

## Context

This library coordinates a single physical resource across an unbounded number of browser
contexts. Most of its code exists to handle situations that are invisible in the happy path:
a tab dying mid-write, a lock changing hands, a device disappearing. Six months from now the
reason a particular `await` sits where it does will not be recoverable from the diff.

Decisions also change. In the library's first four days 16 of 39 records were amended by others,
most of them in place, so that learning one current decision meant reading up to five records and
knowing which of their sentences still held. Code and documentation cite the records by number,
several of them dozens of times, so a record cannot simply disappear either.

## Decision

We record every architectural decision as a numbered Architecture Decision Record in
`docs/adr/`, using a MADR-derived [template](./0000-template.md). Code that exists because of a
decision cites it (`// See ADR-0005.`). Numbers are never reused and never renumbered.

**One current record per decision.** When a decision changes, the record is rewritten to state the
decision as it now stands, with the rejected alternatives that still matter. Amendments are not
appended, and a record carries no history of its own: only what holds today is written down, and
what it used to say is in version control beside the change that moved it.

**Superseded records are stubs.** When a record's decision is replaced by another record, merged
into one, or retired, the old record keeps its number and its file and becomes a stub of a few
lines: `Status: Superseded by ADR-NNNN (date)` and the decision as first recorded in one sentence.
Every citation of its number therefore still resolves, and leads forward to the current decision.

**The index shows what holds.** `docs/adr/README.md` lists the current records, and below them
which number went where. How the library works, rather than why, is described in the Internals
chapter of the developer documentation.

## Alternatives considered

- **Immutable records, with changes appended as amendments.** The rule this record first stated.
  It keeps every word ever accepted, and it produced records whose decision section was wrong and
  whose correction sat at the end, or in another record. A reader has to reconstruct the current
  decision; a reviewer changing the code has to find every amendment first.
- **A new record for every change, the old one superseded in full.** Clean for decisions that are
  replaced by a different mechanism, and still used for those. For a decision that is refined - a
  retry rule made precise, a limit adjusted - it scatters one decision across many numbers.
- **Keeping a history section in every record.** The rule this record first stated after
  immutability was dropped. It records when and why a decision moved, which can stop a reverted
  change from being made again - but it makes every record two documents, one of which nobody
  maintains, and it invites a reader to weigh a superseded sentence against a current one. Only the
  current state is guaranteed; version control holds the rest, with the change that caused it.
- **Deleting superseded records.** Breaks every citation of their numbers in code and documentation.
- **A single `ARCHITECTURE.md`.** Describes the current state and silently loses the rejected
  alternatives - the information that prevents someone re-litigating a decision.
- **Decisions in commit messages, or a wiki.** Not discoverable, and a wiki cannot be reviewed in
  the same pull request as the change it justifies.

## Consequences

### Positive

- Rejected options survive, so the same debate is not repeated.
- A reader finds a decision in one record, and a citation of any number leads to it.
- An ADR is reviewable alongside the code it governs.

### Negative

- A stale record is worse than none, and a record that is rewritten can drift into half-truth.
  Mitigated by folding every change in the same pull request as the code, and by checking a
  record against `src/` whenever it is rewritten.
- Rewriting loses the exact wording of an earlier state, and with no history section the record
  itself no longer says when it moved. Version control keeps both, next to the change that caused
  them.

## Verification

`docs/adr/README.md` lists every current record and every stub; the review checklist requires an
ADR, or a rewritten one, for architectural changes.
