# ADR-0031: Bound and rate-limit what the bus can cost a tab

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** ADR-0018, ADR-0013

## Context

The limits of `protocol/limits.ts` bound what **one** message can cost: how long an identifier may
be, how large a payload, how many values a report may hold (SECURITY.md). Nothing bounded **how
many** messages there are, and every well-formed one was worked on:

- the tab holding the port answered every `status-request` with a broadcast;
- every tab answered every `diagnostics-request` with a report of up to a megabyte;
- every malformed message produced a `warn` record, so a flood of nonsense became a flood in the
  application's log - the one place an operator looks for the real fault;
- every `error` from another tab was delivered to the application's `onError`;
- a diagnostics observer kept every `diagnostics-report` carrying its request id until its window
  closed, and that request id is broadcast, so anything on the bus can answer it, under as many
  invented client ids as it likes;
- every `write-request` was queued at the port, of any number and of any total size, each held
  until it was written or its deadline passed.

The writes are the sharpest of these: 16 MiB per payload (`MAX_PAYLOAD_BYTES`) and no bound on how
many wait. A script of the origin could make the tab holding the port hold gigabytes, and an
application with a loop in it could do the same by accident.

SECURITY.md said this in as many words - "There is no rate limit: every well-formed message is
decoded and handled" - and listed it as something such a script can do. It is the one item on that
list that is not inherent to the missing sender identity.

## Decision

Every place where the bus makes a tab do more than drop a message gets a **named limit**, defined
with its reason in `protocol/limits.ts`, and what is dropped is logged **once** per context, as the
size limits are.

A token bucket (`core/rate-limit.ts`) expresses the rates: `burst` allowed at once, `perSecond`
coming back. A burst is what legitimate use looks like - every tab of an origin asking for the
status as it joins - and what follows it is not.

| What                             | Limit                                                                |
| -------------------------------- | -------------------------------------------------------------------- |
| Answers to `status-request`      | `STATUS_ANSWER_RATE`: 32 at once, 32 per second                      |
| Answers to `diagnostics-request` | `DIAGNOSTICS_ANSWER_RATE`: 8 at once, 4 per second                   |
| Records of malformed messages    | `MALFORMED_MESSAGE_WARNING_RATE`: 16 at once, 2 per second           |
| Errors from other tabs           | `REMOTE_ERROR_RATE`: 32 at once, 8 per second                        |
| Reports kept per collection      | `MAX_REPORTS_PER_COLLECTION`: 1024, as many as the broker keeps tabs |
| Writes waiting at a port         | `MAX_WAITING_WRITES`: 4096, and `MAX_WAITING_WRITE_BYTES`: 64 MiB    |

Two of them are more than a bucket:

- **A status answer is a broadcast**, so requests beyond the rate need no answer of their own: the
  next answer the rate allows is scheduled, and it answers all of them together. No tab that asked
  is left without a status.
- **A write beyond the bound is refused**, with the new error code `WRITE_QUEUE_FULL`, which says
  that nothing of it was written and that it is safe to send again. Holding it would be worse than
  refusing it: that is memory the sender chose. A request the port has already accepted is never
  refused - its bytes may be on their way to the device - so a repeat of it is answered from the
  record of accepted writes as before (ADR-0013). The bound counts the writes of every tab alike,
  the tab holding the port included, so that whether a `send()` works never depends on which tab
  holds the port (ADR-0011).

## Alternatives considered

- **Per-sender rates.** Fairer in principle: a flood from one identity would not cost the others.
  But an identity on the bus is a string the sender chooses, so a flood rotates through identities
  and the bookkeeping becomes the unbounded thing.
- **Drop status requests beyond the rate.** A tab that joined during a flood would then sit at
  `idle` until something changed - possibly hours. Coalescing costs one timer and answers everyone.
- **Queue writes beyond the bound and fail them at their deadline.** They would be held for
  `writeTimeoutMs` first, which is exactly the memory the bound exists to deny.
- **Refuse the write in the issuing tab, from a queue depth in the status.** The depth would be
  stale by the time it was read, and it would put a number about the port's insides into a message
  every tab reads (ADR-0011).
- **Count bytes only.** A flood of empty writes is free in bytes and not free in bookkeeping; a
  count alone lets 4096 payloads of 16 MiB in. Both bounds, or neither.

## Consequences

### Positive

- No message on the bus makes a tab grow, answer or log without bound.
- An operator reading a log sees the first of a flood and one record saying the rest are dropped,
  rather than the flood.
- An application that loops on `send()` now gets `WRITE_QUEUE_FULL` - an error naming the cause -
  instead of a tab that slowly fills with payloads.

### Negative

- A new public error code, `WRITE_QUEUE_FULL`, which applications may see.
- A legitimate burst beyond a rate is dropped: a diagnostics page that asks nine times in two
  seconds gets fewer answers. The values are far above what the library and its debugging surface
  produce.
- The rates are measured with `clock.now()`, so a system clock set forward returns a full allowance
  at once and one set back returns none until it has caught up. Both only affect how much work is
  allowed, never correctness.

### Risks and mitigations

- **A flood can still crowd out legitimate messages within a rate** - a genuine error from another
  tab may be dropped while a script floods `onError`. The status of the configuration, the data and
  the writes are unaffected; only the reports about them are rationed.

## Verification

`test/unit/rate-limit.test.ts` covers the bucket: the burst, the refill, the single record.
`test/integration/multi-tab/hostile-bus.test.ts` floods two tabs sharing a port with status
requests, diagnostics requests, errors and malformed messages, and holds the answers, the reports,
the `onError` events and the log records to their limits - while a tab joining during the flood
still reaches `open`.
`test/integration/multi-tab/write-backlog.test.ts` fills a port's queue and checks that the writes
beyond it are refused with `WRITE_QUEUE_FULL` while the ones within it still wait, and that a
request the port has accepted is never refused.
`test/integration/multi-tab/diagnostics-observer.test.ts` answers a collection from a script of the
origin, under invented identities, and holds what it keeps to `MAX_REPORTS_PER_COLLECTION`.
