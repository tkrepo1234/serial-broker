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

Naive retry loops on a permanently absent device burn CPU and spam the console indefinitely. Some
failures, on the other hand, will not change however often they are retried.

## Decision

The owner runs a **supervisor** (`PortSupervisor`): an explicit state machine - `idle`, `listing`
the granted ports, `opening`, `open`, `reconnecting`, `awaiting-permission`, `failed`, and
`stopped` once the tab stops holding the port - that owns the port lifecycle. Every way to lose a
connection funnels into one handler.

**Backoff.** Reconnect uses exponential backoff with full jitter:

    delay(0) = 0
    delay(n) = min(maxDelayMs, initialDelayMs * factor^(n-1)) * random(jitter, 1)

Defaults: `initialDelayMs: 250`, `factor: 2`, `maxDelayMs: 30000`, `jitter: 0.5`,
`maxAttempts: Infinity`, and **attempt 0 is not delayed** - a power-cycled device is usually
back within one event-loop turn. The counter resets only after a connection has been **stable**
for `stableAfterMs` (default 5 s, measured on the monotonic clock,
[ADR-0014](./0014-dependency-injection-of-the-environment.md)), so a device that accepts `open()`
and immediately drops does not produce a tight loop.

**Rules that make it precise.**

- **The `connect` event short-circuits the backoff timer**: when the matching device reappears, a
  reconnect is attempted at once. A `connect` clears any note of a disconnect: a replugged device
  has a new port object, and it cannot be told whether it is the same one.
- **Device events concern the port the owner holds.** The supervisor acts on a `disconnect` only
  when the event's target is the port it found; a `null` target is taken to be that port.
- **An unplugged device keeps the configuration `reconnecting`.** `getPorts()` does not list a port
  whose USB device is detached. A port missing from the list is a failed attempt, with backoff, when
  the platform fired `disconnect` for the owner's port and no `connect` since. A permission revoked
  in site settings or by `forget()` makes the port disappear without a `disconnect`, and leads to
  `awaiting-permission`; a `disconnect` arriving after that moves the configuration on to
  `reconnecting`.
- **Every `open()`, `close()` and listing is bounded** by `openTimeoutMs` (default 10 s). A hung
  step is a failed attempt, and listing the ports is part of an attempt, never mistaken for one
  already scheduled. Diagnostics report `listing` as its own state.
- **An attempt waits for the previous connection to be closed.** In Chromium `close()` is a round
  trip to the browser process, and `open()` before it returns fails with `InvalidStateError`.
  Stopping also waits for an `open()` still pending and closes the port once it settles, because the
  ownership lock is released right after.
- **Only a retryable failure leads to another attempt.** An attempt that fails with a code that is
  not retryable ends in `failed` at once: an `open()` rejected with `SecurityError`, and a
  `getPorts()` that rejects for any reason other than its deadline, both as
  `WEB_SERIAL_UNAVAILABLE`. A connection that was open and is lost is retried whatever its error.
- **`maxAttempts`** ends in `failed` with `RECONNECT_EXHAUSTED`, reported once per participant.
- **`connection.autoReconnect`** (default `true`). With `false`, a lost connection or failed attempt
  ends in `failed` with its error, nothing is scheduled, and a device plugged in again does not
  revive it. The errors the supervisor reports for them carry `isRetryable: false`, whatever their
  code, because nothing retries them ([ADR-0012](./0012-error-model.md)). A configuration that never
  connected still connects when its device appears: that is the first connection the application
  asked for.
- **A handover does not revive a failed configuration.** With `autoReconnect: false`, a tab that
  takes the port over from a term whose last status it knew was `failed` starts its supervisor in
  `failed`, without an attempt, and keeps the last error code it knew; the tabs that see such a term
  end keep `failed` instead of showing `reconnecting`. The session remembers nothing beyond the
  status it already has. A tab that knows nothing of the failure - the only tab, reloaded - connects
  when it sets the configuration up: that is the application setting it up.
- **Leaving `failed`**: a `connect` event (unless `autoReconnect` is `false`), a successful
  `requestAccess()`, or `setup()` with equal options, which starts again with a fresh attempt
  counter in whichever tab it is called - a tab that does not hold the port sends `status-request`
  with `retry: true`, and the holder retries. A working or reconnecting connection is left alone.
- A write the device has not taken does not end the connection
  ([ADR-0013](./0013-write-ordering-and-delivery-semantics.md)).

## Alternatives considered

- **Fixed-interval polling.** Simple; either too slow to recover or too noisy when absent.
- **Backoff without jitter.** With several tabs, configurations and devices power-cycled by one
  switch, unjittered backoff synchronises the retries into bursts.
- **Retry forever with no ceiling and no terminal state.** Hides a permanently broken setup from the
  operator. The terminal state plus a reported error makes it visible.
- **Reacting only to the `disconnect` event.** Misses the "switched off but still enumerated" case
  entirely, the most common one with RS-232-over-USB adapters.
- **Treat a missing port as absent whenever the device had been opened in this owner's lifetime.**
  Needs no event, but turns a revoked permission into retries forever with no prompt to answer.
- **Keep retrying non-retryable failures with backoff.** A permissions policy does not change while
  the page runs, so every attempt reports the same error to every tab; `failed` is what the
  application should show.
- **`maxAttempts: 0` to switch reconnecting off.** It would still revive on a `connect` event, and
  it hides a yes-or-no decision in a number.
- **Remember a failure beyond the tabs that saw it**, in storage or on the bus, so that a reloaded
  page stays `failed` too. A page that sets a configuration up is the application asking for a
  connection, and a stored failure would need its own rules for when it is forgotten.
- **Keep `isRetryable` a property of the code alone.** The documentation's own examples skip
  retryable errors, and would hide a loss the application has to act on.

## Consequences

### Positive

- Recovery is typically immediate, and hopeless cases degrade quietly to one attempt every 30
  seconds instead of a busy loop.
- Every path into reconnection is one handler, so it is testable in isolation.
- An application can offer "try again" by calling `setup()` again, from any tab.

### Negative

- `stableAfterMs` adds a concept the application can observe only indirectly. It is documented and
  configurable.
- A device whose adapter reports no `disconnect` when unplugged is indistinguishable from a revoked
  permission, and waits in `awaiting-permission`.

## Verification

Scenario matrix rows 8 and 9; `test/unit/backoff.test.ts` asserts schedules exactly with a seeded
random source and fake timers; `test/integration/reconnect.test.ts`, `auto-reconnect.test.ts`,
`non-retryable-failures.test.ts` and `connection-regressions.test.ts`;
`test/integration/auto-reconnect.test.ts` also for `setup()` retrying from any tab, in both
transport modes.
