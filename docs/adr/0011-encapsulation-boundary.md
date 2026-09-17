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

The public surface of the main entry point exposes **no** owner identity, no participant identity,
no participant count, no lock state, no transport identity, no worker reference and no `SerialPort`
object.

Concretely:

- `getStatus(name)` returns `{ name, status, deviceKind, vendorId, productId, serialOptions, since,
observedAt, lastErrorCode }` - the condition of the _connection_ and the device in effect, never
  of the _coordination_.
- The `status` union describes what an application can act on: `idle`, `queued`,
  `awaiting-permission`, `connecting`, `open`, `reconnecting`, `failed`, `released`. Whether the
  local context or a peer is doing the connecting is not represented, because it must not matter.
  `queued` says that the tab limit the application itself set is reached, and nothing about which
  tab holds the port ([ADR-0025](./0025-limit-the-tabs-using-a-configuration.md)).
- `onSend` carries `origin: 'local' | 'remote'` - whether _this_ context issued the write. That is
  information about the caller's own action, not about the topology, and the minimum needed for a
  tab to tell its own echo from a peer's traffic. No peer identifier is included.
- Operators, not applications, see the mechanism: through the separate, read-only entry point
  `serial-broker/diagnostics` ([ADR-0018](./0018-diagnostics-observer.md)), and through the opt-in
  `Logger`. Neither is reachable from the main entry point's API, and neither is covered by SemVer.

## Alternatives considered

- **Expose `isOwner` read-only.** Every reviewer asks for it. Rejected: it is stale the moment it
  is read, it invites exactly the branching this decision prevents, and no legitimate application
  need for it survived examination - the library already routes writes from any context, so there
  is nothing an owner can do that a participant cannot.
- **Expose a participant count.** Useful for dashboards, but it leaks the topology and fluctuates
  during transfers. Operators get it from diagnostics.
- **Expose the `SerialPort`.** Would let one tab close a port other tabs depend on and would
  break every invariant the library maintains. Never.
- **Diagnostics on the main facade.** Puts "who owns the port" one autocomplete away from
  application code (ADR-0018).

## Consequences

### Positive

- The election mechanism, the transport, and the broker can all be replaced without a major
  version bump. ADR-0005 and ADR-0006 are genuinely reversible decisions.
- Applications cannot write code that is subtly wrong about a race they cannot win.

### Negative

- Debugging a multi-tab deployment needs the diagnostics entry point or a logger, not the
  application's own API. Accepted; the logger carries correlating fields on every record.

## Verification

`test/integration/encapsulation.test.ts` asserts the exact set of keys on every public return value
and event payload, and that nothing diagnostic is exported from the main entry point, so an
accidental leak fails the suite rather than shipping.
