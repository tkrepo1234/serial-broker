# ADR-0005: Elect the port owner with the Web Locks API

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

Exactly one window may hold the port ([ADR-0004](./0004-port-ownership-lives-in-a-window.md)).
Two windows believing they are the owner means two `open()` calls on the same device, a
failed second open at best and interleaved corrupt writes at worst. The requirement is a
genuine mutual exclusion, not a convention.

The failure mode that matters is not the graceful one. A tab closed with the close button
runs `pagehide`; a tab killed by the process manager, an OOM kill, a crashed renderer or a
yanked laptop lid runs nothing. Any scheme that depends on a departing tab announcing its
departure will eventually leave a configuration with no owner and no way to notice.

## Decision

Ownership is the
[Web Locks API](https://w3c.github.io/web-locks/) lock named
`serial-broker/owner/<protocolVersion>/<configurationName>`, held in `exclusive` mode for as
long as the window is the owner.

- A window becomes the owner by being granted that lock, and holds it by keeping the lock
  callback's promise pending.
- A window relinquishes ownership by resolving that promise — after closing the port.
- When the owning window dies, **the browser releases the lock** as part of tearing down the
  context, and the longest-waiting window is granted it. Failover needs no timeout, no
  heartbeat, and no cooperation from the dying tab.
- Every window with the configuration set up has a pending lock request outstanding, so there
  is always a successor queued.
- The lock name includes the protocol version, so two incompatible library versions in the
  same origin do not contend for the same lock
  ([ADR-0008](./0008-wire-protocol-and-versioning.md)).

Web Locks are same-origin scoped and cover every window, tab, iframe and worker of that
origin — the exact scope of the problem.

## Alternatives considered

- **Heartbeats in the SharedWorker.** The worker sees a port disconnect when a tab dies, which
  is a genuine signal, and it was the first design. Rejected as the *primary* mechanism: it
  depends on the worker being alive and on choosing a timeout, and it cannot prevent a
  split-brain window between "worker thinks A is dead" and "A is actually still writing". A
  browser-enforced exclusive lock has neither problem. The worker's view of disconnects is
  still used, but only to update *presence*, never to grant ownership.
- **`localStorage` lease with expiry timestamps.** The classic pre-Web-Locks approach.
  Requires clock agreement between tabs, has a documented race on `storage` event delivery,
  and a stalled tab can renew a lease it should have lost. Rejected.
- **First tab wins, elected once at startup.** No recovery path whatsoever.
- **`navigator.locks.request(..., { steal: true })` on suspicion of a dead owner.** Explicitly
  breaks mutual exclusion: it revokes a lock from a context that may be mid-write. Never used.

## Consequences

### Positive
- Failover is correct by construction, including for crashes, and requires no timeout tuning.
- The invariant "at most one owner" is enforced by the browser, not by our code.
- A frozen (bfcache) or backgrounded tab keeps its lock and its port, which is the desired
  behaviour; if the browser discards it, the lock is released and the next tab takes over.

### Negative
- Web Locks are not available in insecure contexts. Neither is Web Serial, so this costs
  nothing in practice; the feature detection reports both together.
- A long-lived pending lock request per configuration per tab. Negligible, but it means the
  request must be aborted (via `AbortSignal`) when a configuration is released, or the tab
  would take ownership of something it no longer cares about.

## Verification

Scenario matrix rows 5, 6, 7 and 16; the harness implements Web Locks FIFO semantics and
abrupt context death, and has its own conformance tests.
