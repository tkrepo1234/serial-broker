# ADR-0010: Supervise the connection with bounded exponential backoff

- **Status:** Accepted, amended 2026-09-14 and 2026-09-15 (twice)
- **Date:** 2026-09-12

## Context

The library must keep the port open across a device being switched off, unplugged, or
power-cycled. The platform surfaces this in several distinct ways, and all of them must lead
to the same recovery:

- `navigator.serial` fires `disconnect` when the device is physically removed.
- An in-flight `reader.read()` rejects, or resolves with `done: true`.
- A `writer.write()` rejects with a `NetworkError` or `BreakError`.
- `port.open()` rejects with `NetworkError` (device gone) or `InvalidStateError` (already
  open - which, after a crash of another context, can be a stale state).
- Nothing happens at all, because the device was switched off without USB detach, and the port
  stays open while producing nothing.

Naive retry loops on a permanently absent device burn CPU and spam the console indefinitely.

## Decision

The owner runs a **supervisor**: an explicit state machine
(`idle -> opening -> open -> reconnecting -> opening -> ...`, plus terminal `failed`) that
owns the port lifecycle. All five signals above funnel into one `handleConnectionLoss(reason)`.

Reconnect uses exponential backoff with full jitter:

    delay(n) = min(maxDelayMs, initialDelayMs * factor^n) * random(jitter, 1)

Defaults: `initialDelayMs: 250`, `factor: 2`, `maxDelayMs: 30000`, `jitter: 0.5`,
`maxAttempts: Infinity`, and **attempt 0 is not delayed** - a power-cycled device is usually
back within one event-loop turn and an immediate first retry avoids a visible outage.

Additionally:

- The `navigator.serial` `connect` event **short-circuits the backoff timer**: when the
  matching device reappears, the pending delay is cancelled and a reconnect is attempted
  immediately. Backoff exists for the unknown case, not for the case where the platform just
  told us the device is back.
- Every `open()` and `close()` is bounded by `openTimeoutMs` (default 10 s) - a hung `open()`
  is treated as a failed attempt and the port object is discarded.
- On `maxAttempts`, the state becomes terminal `failed`, one error is reported per
  participant, and no further attempts are made until the application calls `setup()` again
  or the device reappears via a `connect` event.
- The backoff counter resets only after a connection has been **stable** for
  `stableAfterMs` (default 5 s), so a device that accepts `open()` and immediately drops does
  not produce a tight loop at `initialDelayMs`.

## Alternatives considered

- **Fixed-interval polling.** Simple; either too slow to recover or too noisy when absent.
- **Backoff without jitter.** With several tabs, several configurations and several devices
  power-cycled by one switch, unjittered backoff synchronises the retries into bursts.
- **Retry forever with no ceiling and no terminal state.** Hides a permanently broken setup
  from the operator. The terminal state plus a reported error makes it visible; the `connect`
  event still revives it automatically, so the terminal state is not a dead end.
- **Reacting only to the `disconnect` event.** Misses the "switched off but still enumerated"
  case entirely, which is the most common one with RS-232-over-USB adapters where the adapter
  stays attached and only the device behind it loses power.

## Consequences

### Positive

- Recovery is typically immediate, and hopeless cases degrade quietly to one attempt every
  30 seconds instead of a busy loop.
- Every path into reconnection is one function, so it is testable in isolation.

### Negative

- `stableAfterMs` adds a concept the application can observe only indirectly (as the timing of
  reconnect attempts). Considered acceptable; it is documented and configurable.

## Verification

Scenario matrix rows 8 and 9; backoff schedules are asserted exactly with a seeded random
source and fake timers.

## Amendment (2026-09-13)

A review found paths where the decision above did not hold. The decision is unchanged; these
points make it precise.

- **An unplugged device keeps the configuration `reconnecting`.** `getPorts()` does not list a
  port whose USB device is detached, and the immediate retry used to read that as "never granted"
  and stop in `awaiting-permission` - showing the application a permission button that does
  nothing, and putting the device beyond `maxAttempts`. A port missing from the list is now a
  failed attempt, with backoff, when the platform fired `disconnect` for the port the owner had
  found and has fired no `connect` since. A permission revoked in site settings, or by
  `forget()`, makes the port disappear without a `disconnect` event, and still leads to
  `awaiting-permission`. The read error and the event reach the page separately, so a
  `disconnect` that arrives after a retry already concluded `awaiting-permission` moves the
  configuration on to `reconnecting`. A `connect` event clears the note: a replugged device has a
  new port object, and it cannot be told whether it is the same one.

  _Alternative rejected:_ treating a missing port as absent whenever the device had been opened in
  this owner's lifetime. It needs no event, but it turns a revoked permission into retries forever
  under the default `maxAttempts`, with no prompt the user could answer.

- **Device events concern the port the owner holds.** The client routes events by device filter,
  which an `any` filter or two identical adapters also match. The supervisor acts on a
  `disconnect` only when the event's target is the port it found. A `null` target is taken to be
  that port: a missed disconnect stalls a connection, a spurious one costs a reconnect.
- **An attempt waits for the previous connection to be closed.** In Chromium `close()` is a round
  trip to the browser process, and `open()` before it returns fails with `InvalidStateError`. The
  next attempt, and stopping, wait for that teardown, bounded by `openTimeoutMs` per step.
  Stopping also waits for an `open()` still pending and closes the port once it settles, because
  the ownership lock is released right after (ADR-0005). An abandoned `open()` is closed when it
  settles, not while it is pending.
- **Looking for the port is part of an attempt.** Listing the granted ports has a state of its own
  in the supervisor, so a listing that times out is a failed attempt followed by another, and never
  mistaken for an attempt already scheduled. Diagnostics report it as `opening`, keeping the set of
  states that peers on the same protocol version accept.

## Amendment (2026-09-14)

- **Only a retryable failure leads to another attempt.** An attempt to connect that fails with a code
  that is not retryable ends in `failed` at once, as `maxAttempts` does, and is left the same ways:
  a `connect` event, a successful `requestAccess()`, or `setup()` again. No `RECONNECT_EXHAUSTED`
  follows; the reported error is the reason. Two attempts fail that way today, both with
  `WEB_SERIAL_UNAVAILABLE`: an `open()` rejected with `SecurityError`, and a `getPorts()` that
  rejects for any reason other than its deadline. The first was retried with backoff, forever under
  the default `maxAttempts`, although docs/site/errors.md promises further attempts only for
  retryable codes; the second stopped in `awaiting-permission`, offering a permission prompt that
  cannot help. A connection that was open and is lost is still retried whatever its error: a failed
  write says nothing about whether the port opens again.

  _Alternative rejected:_ keep retrying, with backoff. A permissions policy does not change while the
  page runs, so every attempt reports the same error to every tab, and `failed` is what the
  application should show.

## Amendment (2026-09-15): reconnecting can be switched off, and `setup()` tries again

- **`connection.autoReconnect`** (default `true`). With `false`, a connection that is lost, or an
  attempt that fails, ends in `failed` with its error reported, and nothing is scheduled. A device
  plugged in again does not revive it either. A configuration that never connected - its device was
  absent, it waited in `awaiting-permission` - still connects when the device appears: that is the
  first connection the application asked for, not a reconnect. Asked for by Tim on 2026-09-15 for
  lines where a lost device has to be acknowledged before it is used again.
- **`setup()` with equal options starts a failed configuration again**, with a fresh attempt counter,
  in the tab holding the port. Before, it did nothing, and an application had to release and set up
  again to offer a "try again" button. It is also how an application reconnects with
  `autoReconnect: false`. A working or reconnecting configuration is left alone, as before.

_Alternative rejected:_ `maxAttempts: 0` as the way to switch reconnecting off. It would still revive
on a `connect` event, and it hides a yes-or-no decision in a number.

## Amendment (2026-09-15, protocol 11): `setup()` tries again from any tab

`setup()` with equal options on a `failed` configuration now tries again in whichever tab it is
called. A tab that does not hold the port sends the existing `status-request` with `retry: true`, and
the tab holding the port calls its supervisor's retry, which leaves a working or reconnecting
connection alone. No new message type. `test/integration/multi-tab/session-regressions.test.ts`
covers it in both transport modes.
