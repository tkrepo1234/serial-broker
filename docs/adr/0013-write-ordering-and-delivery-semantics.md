# ADR-0013: Per-participant write ordering with at-most-once delivery

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

Any participant may call `send()`. The bytes must reach the device through the tab holding the
port. Two questions must be answered precisely, because a vague answer here produces corrupted
device traffic:

1. **In what order do writes reach the device?**
2. **What happens to a write that is in flight when the tab holding the port dies, or when the
   device stops taking data?**

Serial devices are stateful and usually command-oriented. Two interleaved commands from two
tabs produce a byte stream that means nothing to the device. A silently retried command can
be executed twice - and for a device that dispenses, cuts, prints or moves something, twice
is materially worse than zero times.

The platform adds two facts, measured against the USB/IP emulator in Microsoft Edge 153 on Windows
11 ([ADR-0035](./0035-browser-tests-with-playwright.md)). A write that fits the port's transmit
buffer (`serial.bufferSize`, 255 bytes by default) resolves at once, although the device took
nothing. And a write the device does not take cannot be withdrawn: `writer.abort()` never settles
while the operating system's write is pending, `port.close()` then never settles either, and
`port.open()` reports the port already open - also after the device takes data again. Only the
page going away frees the port.

## Decision

**Ordering.** Writes are FIFO per participant and atomic per call:

- The tab holding the port serialises all writes through a single queue (`WriteQueue`). A `send()`
  is one entry; the bytes of one call are never interleaved with another's, even when a call is
  written in chunks of `maxWriteChunkBytes`.
- Writes from one participant reach the device in the order that participant issued them.
- Writes from _different_ participants have no defined relative order. Establishing one would
  require a global sequencer and would still be meaningless. Applications that need command
  atomicity across tabs build it on top.

**Delivery: at-most-once.** A `send()` promise settles only when the tab holding the port reports
the outcome:

- **Resolved:** the browser took the bytes for the port. How far they got depends on
  `serial.bufferSize`; a resolved `send()` does not say that the device received them.
- **`WRITE_FAILED`:** the device refused them; nothing was written, or writing stopped part way -
  the context says which.
- **`WRITE_TIMEOUT`:** the write did not finish within `writeTimeoutMs`. Its context says whether
  it had `started` and how many bytes were written.
- **`OWNER_LOST_DURING_WRITE`:** the term of holding the port that began this write ended without a
  result, and the library **cannot** determine whether the bytes reached the device. It does
  **not** retry it.
- **`WRITE_QUEUE_FULL`:** the tab holding the port already holds `MAX_WAITING_WRITES` writes or
  `MAX_WAITING_WRITE_BYTES` of payload ([ADR-0031](./0031-bound-and-rate-limit-what-the-bus-can-cost-a-tab.md)).
  Nothing of it was written, and it is safe to send again. The bound counts every tab's writes
  alike, the holder's own included, so whether a `send()` works never depends on which tab holds
  the port.

A write that has been accepted but _not yet started_ is different: it demonstrably never reached
the device, so it is held and handed to the next term. The tab holding the port reports
`write-started` the moment it begins a write, and that report is what makes the write not
repeatable.

**Where this lives.** The lifecycle of a write belongs to the context that issued it
(`PendingWrites`), not to the broker. That context addresses each request to the term of holding
the port it knows of, holds it until a term exists, marks it non-repeatable on `write-started`,
settles it on `write-result`, and decides its fate when the addressed term ends. Only that term
writes it; a term with no open connection answers `NOT_CONNECTED`, which returns the write to wait
for the next term. Who may report a write's progress, and when a term has ended, is
[ADR-0030](./0030-hold-a-web-lock-for-every-term-of-holding-the-port.md). The tab holding the port
records the requests it accepted in its term (`AcceptedWrites`), so a request handed to it twice is
answered with its known outcome and never written twice.

**A write the device does not take stays in flight.** A chunk that outlives `writeTimeoutMs` at the
device does not end the connection:

- The caller's `send()` rejects with `WRITE_TIMEOUT` at the deadline; the rest of that payload is
  never written.
- The chunk keeps its place at the head of the queue: nothing behind it begins until the device has
  taken it. Those writes fail at their own deadline with `WRITE_TIMEOUT` and `started: false`, so
  the application may send them again.
- The tab logs `supervisor.write-stalled` (warn, without payload bytes), and diagnostics report
  since when a write has been stuck.
- When the device takes the chunk, the queue carries on with no reconnection and no status change.
  When the chunk fails instead, that is a lost connection: `WRITE_FAILED` and reconnection
  ([ADR-0010](./0010-reconnect-supervision-and-backoff.md)).

A write the device rejects outright still ends the connection: an errored stream holds no write, so
closing it works.

## Alternatives considered

- **At-least-once with automatic retry after failover.** Tempting and wrong. Duplicate commands to
  industrial hardware cause physical damage. Rejected outright.
- **Exactly-once.** Not achievable: there is no acknowledgement from a raw serial device, so "did
  the bytes arrive" is unknowable at this layer.
- **Global FIFO across all participants.** Requires a sequencer in the broker, adds a round trip to
  every write, and delivers an ordering guarantee no application can use.
- **Rejecting all writes during an ownership transfer.** Turns a 50 ms handover into a visible error
  for writes that were never at risk. The hold-and-hand-on window, bounded by `writeTimeoutMs`,
  covers the common case correctly.
- **Tear the connection down when a write times out.** What the supervisor did until 2026-09-15. On
  a device that pauses, the close never completes, so the configuration reconnected for ever and
  the port stayed held for every tab. A longer close deadline does not help: the close does not
  complete late, it does not complete.
- **Abort without closing, and keep using the port.** An aborted writable stream cannot be written
  to again, and a new one exists only after a close.
- **Keep writing behind the stuck chunk.** The browser would queue the bytes and deliver them when
  the device recovers - including writes whose callers were told `WRITE_TIMEOUT` long ago.
- **Queue writes beyond the bound and fail them at their deadline.** They would be held for
  `writeTimeoutMs` first, which is exactly the memory the bound exists to deny.
- **Refuse the write in the issuing tab, from a queue depth in the status.** The depth would be
  stale on arrival, and it would put the port's insides into a message every tab reads.

## Consequences

### Positive

- The contract is stateable in one sentence per outcome and is testable exactly.
- No scenario the library can see causes a command to be executed twice by the library.
- A device that stops taking data and comes back is used again by the same tabs, without a reload.
- An application that loops on `send()` gets an error naming the cause instead of a tab that fills
  with payloads.

### Negative

- `OWNER_LOST_DURING_WRITE` puts an undecidable case in front of the application. Only the
  application knows whether its command is idempotent; the remediation names the choice.
- A tab that crashes between handing bytes to the device and its `write-started` arriving leaves a
  write that looks unstarted; it is handed on and may reach the device twice. The window is the
  transit of one message against the teardown of a crashed renderer (ADR-0030).
- While a chunk is stuck, the status stays `open` and reads go on, but every write fails. No status
  says so; `WRITE_TIMEOUT` does.
- Releasing a configuration while a chunk is stuck still cannot close the port; it stays held until
  the page goes. That is the platform's limit, reached only on release.
- Measured with an emulated device under usbip-win2. Whether a physical adapter's driver ends a
  pending write is unknown; a write that does end, ends the stall.

## Verification

Scenario matrix rows 4, 7 and 15. `test/unit/pending-writes.test.ts`,
`test/unit/accepted-writes.test.ts` and `test/unit/write-queue.test.ts`;
`test/integration/multi-tab/failover.test.ts` kills the tab holding the port between queued and
started, and after started; `handover-races.test.ts` and `peer-write-regressions.test.ts`;
`write-backlog.test.ts` for `WRITE_QUEUE_FULL`; `test/integration/connection-regressions.test.ts`,
"a device that stops taking writes"; and `test/browser/hardware/emulator.spec.ts`, which pins the
measured browser behaviour so a Chromium that changes it fails.

## History

- 2026-09-12: Accepted - a new owner's claim decided the fate of in-flight writes.
- 2026-09-14: Writes addressed to a term (ADR-0026); terms are Web Locks (ADR-0030); the waiting
  writes bounded, `WRITE_QUEUE_FULL` (ADR-0031).
- 2026-09-15: A write the device has not taken stays in flight, and a resolved `send()` means the
  browser took the bytes (ADR-0038, folded in).
