# ADR-0013: Per-participant write ordering with at-most-once delivery

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

Any participant may call `send()`. The bytes must reach the device through the owner. Two
questions must be answered precisely, because a vague answer here produces corrupted device
traffic:

1. **In what order do writes reach the device?**
2. **What happens to a write that is in flight when the owner dies?**

Serial devices are stateful and usually command-oriented. Two interleaved commands from two
tabs produce a byte stream that means nothing to the device. A silently retried command can
be executed twice - and for a device that dispenses, cuts, prints or moves something, twice
is materially worse than zero times.

## Decision

**Ordering.** Writes are FIFO per participant and atomic per call:

- The owner serialises all writes through a single queue. A `send()` call is one queue entry;
  the bytes of one call are never interleaved with the bytes of another, even when a call is
  chunked for a device with a small buffer.
- Writes from one participant reach the device in the order that participant issued them.
- Writes from _different_ participants have no defined relative order. Establishing one would
  require a global sequencer and would still be meaningless - the application cannot know
  what another tab is about to send. Applications that need command atomicity across tabs
  must build it on top; the README says so plainly.

**Delivery: at-most-once.** A `send()` promise settles only when the owner reports the outcome:

- Resolved: the bytes were handed to the device.
- Rejected with `WRITE_FAILED`: the device refused them; nothing was written, or writing
  stopped part way - the context says which, and the application must decide.
- Rejected with `OWNER_LOST_DURING_WRITE`: the owner died while this write was in flight, and
  the library **cannot** determine whether the bytes reached the device. The library does
  **not** retry it.

A write that has been accepted but _not yet started_ by the owner is different:
it is held and handed to the new owner, because it demonstrably never reached the device. The
distinction is tracked explicitly - the owner acknowledges each queue entry at the moment it
starts writing it, and that acknowledgement is what makes the entry non-replayable.

**Where this lives.** The lifecycle of a write belongs to the context that issued it, not to
the broker. That context holds the request until an owner is available, marks it
non-replayable when the owner reports `write-started`, and resolves it when the owner reports
a result or when a _new_ owner announces itself - which is the signal that the previous one is
gone. The decision cannot sensibly live anywhere else: only the issuing context knows what it
asked for, and putting it there makes the behaviour identical under both transports and
independent of the broker being alive.

## Alternatives considered

- **At-least-once with automatic retry after failover.** Tempting and wrong. Duplicate
  commands to industrial hardware cause physical damage. Rejected outright.
- **Exactly-once.** Not achievable: there is no acknowledgement from a raw serial device, so
  "did the bytes arrive" is unknowable at this layer. Claiming it would be a lie.
- **Global FIFO across all participants.** Requires a sequencer in the broker, adds a round
  trip to every write, and delivers an ordering guarantee that no application can actually
  use.
- **Rejecting all writes during an ownership transfer.** Simpler, but turns a 50 ms handover
  into a visible application error for writes that were never at risk. The hold-and-flush
  window (bounded by `writeTimeoutMs`) covers the common case correctly.

## Consequences

### Positive

- The contract is stateable in one sentence per outcome and is testable exactly.
- No scenario can cause a command to be executed twice by the library.

### Negative

- `OWNER_LOST_DURING_WRITE` puts an undecidable case in front of the application. That is
  honest: only the application knows whether its command is idempotent. The error carries a
  remediation naming the choice.

## Verification

Scenario matrix rows 4, 7 and 15; a dedicated test kills the owner between queued and started and asserts the
write is delivered to the successor exactly once, then kills it after started and asserts the
write rejects with `OWNER_LOST_DURING_WRITE` and is never replayed.
