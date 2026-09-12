# ADR-0011: Expose nothing about the coordination mechanism

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

The stated requirement is explicit: users of the library must not need to know which context
owns the port. Beyond ergonomics, there is a hard engineering reason. Anything observable
becomes load-bearing: if an application can ask "am I the owner?", some application will
branch on it, and every future change to the election mechanism becomes a breaking change to
that application. Worse, an application that believes it is the owner will be wrong
microseconds later, and any code built on that belief is a race.

## Decision

The public surface exposes **no** owner identity, no participant identity, no participant
count, no lock state, no transport identity, no worker reference and no `SerialPort` object.

Concretely:

- `getStatus(name)` returns `{ status, vendorId, productId, serialOptions, since,
lastErrorCode }` - the condition of the _connection_, never of the _coordination_.
- The `status` union describes what an application can act on: `idle`, `awaiting-permission`,
  `connecting`, `open`, `reconnecting`, `failed`, `released`. Whether the local context or a
  peer is doing the connecting is not represented, because it must not matter.
- `onSend` carries `origin: 'local' | 'remote'` - whether _this_ context issued the write.
  That is information about the caller's own action, not about the coordination topology, and
  it is the minimum needed to satisfy the requirement that a tab can tell its own echo from a
  peer's traffic. No peer identifier is included.
- Diagnostics that would reveal the mechanism exist only through the opt-in `Logger` at
  `debug` level, which is explicitly documented as unstable and not covered by SemVer.

## Alternatives considered

- **Expose `isOwner` read-only.** Every reviewer asks for it. Rejected: it is stale the moment
  it is read, it invites exactly the branching this decision prevents, and no legitimate
  application need for it survived examination - the library already routes writes from any
  context, so there is nothing an owner can do that a participant cannot.
- **Expose a participant count.** Useful for dashboards, but it leaks the topology and
  fluctuates during transfers. If a genuine need appears, it can be added later as an opt-in
  diagnostic; removing it later would be breaking, so it is not added speculatively.
- **Expose the `SerialPort`.** Would let one tab close a port other tabs depend on and would
  break every invariant the library maintains. Never.

## Consequences

### Positive

- The election mechanism, the transport, and the broker can all be replaced without a major
  version bump. ADR-0005 and ADR-0006 are genuinely reversible decisions.
- Applications cannot write code that is subtly wrong about a race they cannot win.

### Negative

- Debugging a multi-tab deployment requires enabling the logger. Accepted, and the reason
  the logger interface carries correlating fields on every record.

## Verification

A test asserts the exact set of keys on every public return value and event payload, so an
accidental leak fails the suite rather than shipping.
