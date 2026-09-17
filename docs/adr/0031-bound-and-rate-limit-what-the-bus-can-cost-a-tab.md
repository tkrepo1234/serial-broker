# ADR-0031: Bound and rate-limit what the bus can cost a tab

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

The limits of `protocol/limits.ts` bound what **one** message can cost: how long an identifier may
be, how large a payload, how many values a report may hold (SECURITY.md). Nothing bounded **how
many** messages there are, and every well-formed one was worked on:

- the tab holding the port answered every `status-request` with a broadcast;
- every tab answered every `diagnostics-request` with a report of up to a megabyte;
- every malformed message produced a `warn` record, so a flood of nonsense became a flood in the
  application's log - the one place an operator looks for the real fault;
- a diagnostics observer kept every `diagnostics-report` carrying its request id until its window
  closed, and that request id is broadcast, so anything on the bus can answer it, under as many
  invented client ids as it likes;
- every `write-request` was queued at the port, of any number and of any total size.

The writes are the sharpest of these: 16 MiB per payload (`MAX_PAYLOAD_BYTES`) and no bound on how
many wait. A script of the origin could make the tab holding the port hold gigabytes, and an
application with a loop in it could do the same by accident.

## Decision

Every place where the bus makes a tab do more than drop a message gets a **named limit**, defined
with its reason in `protocol/limits.ts`, and what a flood would repeat is logged through one
`OnceLog`, **once per key** - a kind of malformed message, an exceeded limit - rather than once per
message.

A token bucket (`core/rate-limit.ts`) expresses the rates: `burst` allowed at once, `perSecond`
coming back. A burst is what legitimate use looks like - every tab of an origin asking for the
status as it joins - and what follows it is not. The allowance is measured on the **monotonic
clock** ([ADR-0014](./0014-dependency-injection-of-the-environment.md)), so setting the system time
neither refills it at once nor freezes it.

| What                             | Limit                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Answers to `status-request`      | `STATUS_ANSWER_RATE`: 32 at once, 32 per second                                                                          |
| Answers to `diagnostics-request` | `DIAGNOSTICS_ANSWER_RATE`: 8 at once, 4 per second                                                                       |
| Reports kept per collection      | `MAX_REPORTS_PER_COLLECTION`: 1024, as many as the broker keeps tabs, and `MAX_REPORT_CHARACTERS_PER_COLLECTION`: 16 MiB |
| Writes waiting at a port         | `MAX_WAITING_WRITES`: 4096, and `MAX_WAITING_WRITE_BYTES`: 64 MiB                                                        |

- **A status answer is a broadcast**, so requests beyond the rate need no answer of their own: the
  next answer the rate allows is scheduled, and it answers all of them together. No tab that asked
  is left without a status.
- **A write beyond the bound is refused** with `WRITE_QUEUE_FULL`, never held; what that means for
  the write is [ADR-0013](./0013-write-ordering-and-delivery-semantics.md).
- **Diagnostics answers and collections** are described in [ADR-0018](./0018-diagnostics-observer.md).
- Errors from other tabs need no rate: they are believed only from a context speaking for a known
  term of holding the port ([ADR-0030](./0030-hold-a-web-lock-for-every-term-of-holding-the-port.md)).

## Alternatives considered

- **Per-sender rates.** Fairer in principle: a flood from one identity would not cost the others.
  But an identity on the bus is a string the sender chooses, so a flood rotates through identities
  and the bookkeeping becomes the unbounded thing.
- **Drop status requests beyond the rate.** A tab that joined during a flood would then sit at
  `idle` until something changed - possibly hours. Coalescing costs one timer and answers everyone.
- **Count bytes only.** A flood of empty writes is free in bytes and not free in bookkeeping; a
  count alone lets 4096 payloads of 16 MiB in. Both bounds, or neither - which is why the reports a
  collection keeps are bounded in both as well.
- **Rates for malformed-message records and for errors from other tabs.** What this record first
  decided (`MALFORMED_MESSAGE_WARNING_RATE`, `REMOTE_ERROR_RATE`). Logging once per kind of fault,
  and believing errors only from the tab holding the port, bound the same things with less code.
- **Measure the rates on the wall clock.** A clock set forward would return a full allowance at
  once, and one set back none until it caught up.

## Consequences

### Positive

- No message on the bus makes a tab grow, answer or log without bound.
- An operator reading a log sees the first of a flood and nothing more of the same kind, rather
  than the flood.

### Negative

- A new public error code, `WRITE_QUEUE_FULL`, which applications may see.
- A legitimate burst beyond a rate is dropped: a diagnostics page that asks nine times at once
  gets eight answers. The values are far above what the library and its debugging surface
  produce.
- Once per key means a second, different occurrence of a known fault is not logged again.

### Risks and mitigations

- **A flood can still crowd out legitimate answers within a rate.** The status of the configuration,
  the data and the writes are unaffected; only the reports about them are rationed.

## Verification

`test/unit/rate-limit.test.ts` covers the bucket: the burst, the refill, the monotonic clock.
`test/integration/multi-tab/hostile-bus.test.ts` floods two tabs sharing a port with status
requests, diagnostics requests, errors and malformed messages, and holds the answers, the reports,
the `onError` events and the log records to their limits - while a tab joining during the flood
still reaches `open`. `test/integration/multi-tab/write-backlog.test.ts` fills a port's queue;
`test/integration/multi-tab/diagnostics-observer.test.ts` answers a collection under invented
identities; `test/unit/bus-limits.test.ts` holds every size limit.
