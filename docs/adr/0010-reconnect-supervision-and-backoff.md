# ADR-0010: Supervise the connection with bounded exponential backoff

- **Status:** Accepted
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
