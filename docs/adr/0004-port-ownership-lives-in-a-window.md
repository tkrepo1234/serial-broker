# ADR-0004: The physical port is owned by a window, not by the worker

- **Status:** Accepted

## Context

The obvious design for "one port, many tabs" is to move the port into the `SharedWorker`:
one context, one owner, no election, no failover. That design is impossible.

The Web Serial API is exposed on `Navigator` only. `navigator.serial` is **not** available in
a `SharedWorker`, and is not exposed in `WorkerNavigator` at all
([W3C Web Serial API](https://wicg.github.io/serial/), `[SecureContext, Exposed=Window]` on
the `Serial` interface). Furthermore `Serial.requestPort()` requires
[transient user activation](https://html.spec.whatwg.org/multipage/interaction.html#transient-activation),
which by definition only exists in a window that received a user gesture.

So the only context that can hold a `SerialPort` is a window - and windows are exactly the
things that disappear without warning.

## Decision

The physical port is opened and held by **one window at a time**, called the **owner**. The
`SharedWorker` never touches the port; it is a message broker only
([ADR-0006](./0006-sharedworker-as-message-broker.md)). Ownership is elected across windows
([ADR-0005](./0005-owner-election-via-web-locks.md)) and moves automatically when the owning
window goes away.

Every participant - owner or not - sees the same events and can issue writes; the bytes are
written by whichever window holds the port
([ADR-0011](./0011-write-ordering-and-delivery-semantics.md)).

## Alternatives considered

- **Port in the SharedWorker.** Impossible, as above. Recorded because it is the first thing
  every reader proposes.
- **A Service Worker holding the port.** Same exposure problem, plus service workers are
  terminated aggressively by the browser - the worst possible host for a long-lived hardware
  handle.
- **A native helper / WebSocket bridge.** Genuinely solves the problem and is what some
  products do, but it requires installing software on the machine and abandons the premise
  of a browser-only library. Out of scope.
- **No sharing: each tab opens its own port.** What the platform gives you. `open()` on an
  already-open port fails with `InvalidStateError`, so this is precisely the problem being
  solved.

## Consequences

### Positive

- Works with the platform as specified, with no native component.
- The owner is a normal window, so it can also prompt for permission when needed.

### Negative

- Ownership transfer is unavoidable and is the hardest part of the library. The port is
  necessarily closed when the owning window dies (the browser closes it with the context), so
  a transfer always includes a reopen, with a brief gap in which no read is in flight. This
  gap is reported as `reconnecting`, never hidden.
- Data that arrives during the transfer gap can be lost - the device is talking to nobody.
  This is a property of the platform, documented, and the reason
  [ADR-0011](./0011-write-ordering-and-delivery-semantics.md) promises _at-most-once_
  delivery rather than exactly-once.

## Verification

Scenario matrix rows 5, 6 and 7 in [testing.md](../guidelines/testing.md).
