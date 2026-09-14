# ADR-0026: Attribute ownership, write and status messages to a term of holding the port

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** ADR-0013

## Context

ADR-0013 lets the tab that issued a write decide its fate: it marks the write not repeatable when
the owner reports `write-started`, settles it with `write-result`, and - when a new owner announces
itself with `owner-claimed` - fails a started write with `OWNER_LOST_DURING_WRITE` and hands an
unstarted one to the new owner. That rested on the new claim being the proof that the old owner is
gone.

It proves less. The lock cannot be granted while it is held (ADR-0005), so a claim proves that the
former owner let go of the lock. It does not prove that the former owner's last messages have
arrived: they come from another sender, and nothing orders the messages of two senders against each
other - not the `BroadcastChannel`, and not a busy main thread that takes its queued tasks in
whatever order. Two defects followed, both reproducible:

- **A write that succeeded failed.** The former owner wrote it, sent its `write-result`, and let go
  of the lock; the issuing tab heard the new claim first and failed the write with
  `OWNER_LOST_DURING_WRITE`.
- **A write reached the device twice.** The former owner wrote it and let go; the issuing tab heard
  the new claim before `write-started`, took the write for unstarted, and handed it to the new owner,
  which wrote it again. The new owner recognises repeated requests (ADR-0013), but only within its
  own time of holding the port.

The former owner also sent `owner-released` before closing the port and draining its writes, so
even that message did not follow the results.

## Decision

Every **term** of holding a configuration's port - from being granted the ownership lock to letting
it go - has an identifier, created by the tab that is granted the lock. The protocol version becomes 7.

- `owner-claimed`, `owner-released`, `write-started` and `status` carry the sender's term.
  `write-result` carries the term of the tab answering: the one the write was performed in, or, for
  `NOT_CONNECTED`, the one it holds or last held the port in.
- `write-request` carries the term it is **addressed** to, the term of the owner as far as the issuer
  knows. A tab writes a request only in that term; any other tab, or the same tab in another term,
  answers `NOT_CONNECTED`. So a request is only ever written by the term its issuer chose.
- The owner stops in this order: close the port, wait for every write it performed to be answered
  (bounded by `writeTimeoutMs`), send `owner-released`, release the lock. `owner-released` is the
  term's last message, and a sender's messages keep their order, so a tab that hears it has heard
  everything that term said about its writes.

The issuing tab keeps, per write, the term it addressed and the term that began it, and tracks the
terms it has heard of:

- A term **ends** when its `owner-released` arrives, or - for a term that was succeeded without
  one, because its tab crashed or its goodbye is still on the way - when `FORMER_OWNER_GRACE_MS`
  (one second) has passed without a message from it. Every message from a term that is waited for
  starts the wait afresh.
- A write that a term began is failed with `OWNER_LOST_DURING_WRITE` only when that term has ended
  without a result.
- A write addressed to a term that has not begun it is handed to another term only when that term
  has ended. `NOT_CONNECTED` releases it at once only when it comes from the addressed term.
- A claim or status of a term that has ended or been succeeded is stale and changes nothing, and
  `owner-released` shows `reconnecting` only for the term that holds the port as far as the tab
  knows.

The worker handshake (ADR-0024) and the version announcement (ADR-0023) do not change.

## What remains unknowable

- **An owner that crashes while writing** leaves the write undecidable, as before: it fails with
  `OWNER_LOST_DURING_WRITE`, now once the grace period has passed rather than at the new claim.
- **An owner that crashes after handing bytes to the device but before its `write-started` reaches
  the issuer**, or whose messages take longer than the grace period to arrive once its successor has
  been heard of, cannot be told from one that never received the write. The write is handed to the
  successor and may reach the device twice. The owner sends `write-started` before the first byte,
  so this needs a message that was sent to arrive more than a second late.
- **A write still in progress when the owner has closed the port** and waited `writeTimeoutMs` is
  answered after `owner-released`. The issuer has failed it with `OWNER_LOST_DURING_WRITE` by then,
  and ignores the late answer.
- **A term's first message arriving after the first message of a later term** makes the earlier
  term look like the successor. The later term is then waited for, and a write it began and has not
  answered within the grace period, sending nothing else, is failed although it may still complete.
  This needs a claim delayed beyond an entire later term's claim.

## Alternatives considered

- **Order all messages through one sequencer.** The broker already delivers in the order it
  received, but the `BroadcastChannel` fallback has no broker (ADR-0007), and a busy tab does not
  process queued tasks in a defined order either.
- **Keep the claim as the proof, and wait a fixed delay after it before deciding.** Needs no
  protocol change, but a clean handover then waits for nothing, and a late message cannot be
  attributed: a result could belong to the new owner or to the old one.
- **Number the terms, so tabs can tell earlier from later.** A new owner cannot know the number of
  the term before it: it may never have heard of it. Storage shared between tabs is updated
  asynchronously across processes, so it cannot provide the number either.
- **Have the new owner ask the old one what it accepted.** The old one may have crashed, which is the
  case that matters.

## Consequences

### Positive

- A clean handover no longer fails a write that succeeded, and no longer writes one twice, on either
  transport.
- A late status or goodbye from a former owner no longer overwrites the status of the current one.

### Negative

- A write in flight when the owner crashes waits up to a second longer: until the grace period has
  passed, it is neither handed on nor failed.
- The other tabs show `reconnecting` only once the departing owner has closed the port, which in
  Chromium is a round trip to the browser process.
- A request addressed to a former owner's term that reaches the new owner costs a round trip.

### Risks and mitigations

- A grace period that is too short turns a slow message into a possible duplicate; one that is too
  long delays failover of writes. One second is far above the time a message takes between tabs and
  below the default `writeTimeoutMs`.

## Verification

`test/integration/multi-tab/handover-races.test.ts`, in both transport modes, reproduces both
defects and a late `owner-released` with a tab whose messages from the former owner are held back,
and fails without this decision. `test/unit/owner-terms.test.ts` and `test/unit/pending-writes.test.ts`
cover the rules, and `test/integration/multi-tab/failover.test.ts` the grace period after a crash.
