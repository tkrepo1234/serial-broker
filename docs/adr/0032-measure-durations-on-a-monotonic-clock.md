# ADR-0032: Measure durations on a monotonic clock, timestamp events on the wall clock

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** ADR-0014

## Context

The injected `Clock` (ADR-0014) had one reading, `now()`, implemented as `Date.now()`, and
everything used it: the `timestamp` of an error, the moments in a diagnostics report, and every
duration the library measures — how long a connection had held before it broke
(`connection.stableAfterMs`), how long a write had waited at the tab holding the port
(`connection.writeTimeoutMs`), how late a deadline ran (`late-deadline.ts`), and, in the worker,
how long a tab had been silent (ADR-0021).

`Date.now()` is not a clock that measures anything. It jumps whenever the user corrects the time,
whenever a laptop crossing a time zone updates it, and on every NTP step; a jump of an hour is
ordinary on a machine that has just woken. A duration computed from two such readings is then
wrong by the size of the jump, in either direction, while the timers waiting for the same duration
are unaffected: browsers run timers on a monotonic clock. So the library and its own timers
disagreed exactly when the times were least normal:

- A connection that had been open for hours counted as unstable when the clock had been set back,
  so its first retry after a drop was delayed and counted towards `maxAttempts`; one that opened
  and dropped at once counted as stable when the clock had been set forward, which is the loop
  `stableAfterMs` exists to prevent.
- Writes waiting at the port were refused with `WRITE_TIMEOUT` the moment the clock was set
  forward, although their issuers were still waiting and their own deadlines had not passed.
- A deadline looked late, and yielded a task for nothing, after a step forward; after a step back a
  genuinely late one looked punctual.
- In the worker, a step forward made every connected tab look silent for longer than
  `SILENT_PARTICIPANT_TIMEOUT_MS`, and the next sweep forgot all of them at once.

`performance.now()` is the monotonic clock browsers expose. It is available in a window and in a
worker, needs no permission, and is the same clock `setTimeout` counts on.

## Decision

`Clock` has two readings, and which one to use follows from what is being read:

- **`now()` — epoch milliseconds, `Date.now()`.** For a moment that leaves the tab: the `timestamp`
  of an error, the time of an event, `openedAt`, `nextAttemptAt`, `statusSince`, `collectedAt`.
  These are read by people and compared with the application's own records, so they have to be the
  system clock, jumps and all.
- **`monotonicNow()` — milliseconds from an arbitrary origin, `performance.now()`.** For every
  duration: the stability window in `BackoffState`, the expiry of a write waiting at the port,
  the lateness test in `scheduleDeadline` (and so the former-owner grace period, ADR-0026), and the
  silence sweep in the worker. A single reading is meaningless and appears in no message, record or
  report.

The rule is: a number that is subtracted from another number is monotonic; a number that is shown
or sent is the wall clock.

## Alternatives considered

- **Keep one reading and clamp negative differences.** Two lines, and it hides only half the
  problem: a clock set back would no longer produce a negative duration, but a clock set forward
  would still expire writes and reset backoff early. It also silently turns a wrong measurement
  into a plausible one.
- **Make `now()` itself monotonic and derive timestamps from it.** The library would then stamp
  errors and events with a number that means nothing outside the tab, and no support case could be
  matched against an application's own log.
- **Measure durations by counting timers.** Timers are exactly what runs late in a throttled or
  frozen tab, which is the case `scheduleDeadline` exists to detect; a measurement made of the
  thing being measured cannot detect it.
- **Take the monotonic reading from the platform directly, where it is needed.** Cheaper, and it
  puts a browser global back into the library that ADR-0014 removed, leaving a test unable to
  control it.

## Consequences

### Positive

- Setting the system clock, in either direction, changes nothing about reconnect behaviour, write
  expiry, the grace period or the worker's view of which tabs are alive.
- A duration and the timer waiting for the same duration now agree by construction.
- The distinction is in the type: a reader of `monotonicNow()` can see that the value must not be
  reported, and a reader of `now()` that it must not be subtracted.

### Negative

- Every stand-in for the environment has one more method, including the harness's clocks.
- Two readings of "the time" are two chances to pick the wrong one. The names, the TSDoc on both,
  and this record are the mitigation; a duration measured with `now()` is now a review finding.

### Risks and mitigations

- Whether a machine's sleep counts towards `performance.now()` differs between platforms, as it
  does for timers. Both are affected the same way, so a duration and its timer stay consistent —
  which is what matters here; the library never needs to know how long a machine slept.
- The origin of `performance.now()` is per context, so readings from two tabs must never be
  compared. Nothing does: every duration is measured within the context that measures it, and
  nothing monotonic crosses the bus.

## Verification

`test/integration/monotonic-time.test.ts`: a connection that held for `stableAfterMs` across the
clock being set back an hour still counts as stable, and one that broke at once across a step
forward still counts as unstable. `test/integration/multi-tab/browser-lifecycle.test.ts`: a write
waiting at the port is withdrawn on schedule with the clock set back, and is written, not refused,
with the clock set forward. `test/unit/late-deadline.test.ts`: lateness follows the stalled
monotonic clock, and a step of the system clock makes no punctual deadline late.
`test/harness/harness-conformance.test.ts`: `FakeClock.monotonicNow()` ignores
`jumpWallClock`, and `FakeClock.stall()` lets time pass without running a timer.
