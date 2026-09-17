# ADR-0001: Record architecture decisions, one current record per decision

- **Status:** Accepted

## Context

This library coordinates a single physical resource across an unbounded number of browser
contexts. Most of its code exists to handle situations that are invisible in the happy path:
a tab dying mid-write, a lock changing hands, a device disappearing. The reason a particular
`await` sits where it does is not recoverable from the code alone.

Decisions also move. A reader who wants to know what holds has one question - what is decided, and
why - and a record that answers it with a sequence of amendments makes the reader reconstruct the
answer. Code and documentation cite the records by number, so a number has to keep its meaning.

## Decision

We record every architectural decision as a numbered Architecture Decision Record in
`docs/adr/`, using a MADR-derived [template](./0000-template.md). Code that exists because of a
decision cites it (`// See ADR-0005.`). Numbers are never reused and never renumbered.

**One current record per decision.** A record states the decision as it stands, in the present
tense, with the reasons that hold and the alternatives that lose to it. When a decision moves, the
record is rewritten in place to describe the current state. It carries no amendments, no history
and no account of how the decision was reached; version control keeps every earlier wording, next
to the change that moved it.

**A record that does not apply is removed.** When a decision is replaced by another record, merged
into one, or dropped, its record is deleted, and every citation of its number - in code, in tests
and in the documentation - moves to the record that holds the decision, or goes, in the same
change.

**The index shows what holds.** `docs/adr/README.md` lists the current records, and nothing else.
How the library works, rather than why, is described in the Internals chapter of the developer
documentation.

## Alternatives considered

- **Immutable records, with changes appended as amendments.** Every word ever accepted is kept, and
  a record's decision section can be wrong while its correction sits at its end, or in another
  record. A reader has to reconstruct the current decision; a reviewer changing the code has to
  find every amendment first.
- **A record for every change, the one before superseded in full.** A decision that is refined - a
  retry rule made precise, a limit adjusted - would be scattered across many numbers.
- **A history section in every record.** It makes every record two documents, one of which nobody
  maintains, and it invites a reader to weigh a sentence that does not hold against one that does.
  Version control holds the history, with the change that caused it.
- **A stub in place of a removed record**, naming the record that holds the decision, so that every
  number resolves. A stub states a decision that does not hold, so a reader following a citation
  is taught it. Moving the citation gives the same guarantee and lands the reader on the answer.
- **A single `ARCHITECTURE.md`.** Describes the current state and silently loses the rejected
  alternatives - the information that prevents someone re-litigating a decision.
- **Decisions in commit messages, or a wiki.** Not discoverable, and a wiki cannot be reviewed in
  the same pull request as the change it justifies.

## Consequences

### Positive

- Rejected options are on record, so the same debate is not repeated.
- A reader finds a decision in one record, and every citation leads to a record that holds.
- An ADR is reviewable alongside the code it governs.

### Negative

- A stale record is worse than none, and a record that is rewritten can drift into half-truth.
  Mitigated by rewriting a record in the same pull request as the code, and by checking it against
  `src/` whenever it is rewritten.
- The record itself does not say when or how its decision moved. Version control does.

## Verification

`docs/adr/README.md` lists every current record and nothing else, and no citation anywhere in the
tree names a number that has no record; the review checklist requires an ADR, or a rewritten one,
for architectural changes.
