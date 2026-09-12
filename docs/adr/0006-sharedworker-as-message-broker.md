# ADR-0006: Use a SharedWorker as the message broker

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

Every participant must see every received chunk, every write performed by any participant, and
every status change — in the same order, with no duplicates. Writes from non-owning
participants must reach the owner and be acknowledged back to their originator.

Ownership is already solved by Web Locks ([ADR-0005](./0005-owner-election-via-web-locks.md)).
What remains is routing.

## Decision

A `SharedWorker` acts as the **broker**: a single, long-lived context that holds a
`MessagePort` to every participant and routes messages between them.

Its responsibilities are deliberately narrow:

1. Track which contexts are interested in which configuration.
2. Resolve the three delivery targets a message can carry: `all` (every participant of a
   configuration except the sender), `owner` (whoever currently holds the port), and a
   specific participant.
3. Forget contexts that have gone away.

It explicitly does **not**: touch the port, decide who the owner is, hold or replay writes,
interpret payloads, or persist anything. Its cached notion of who the owner is exists purely
for routing and is never an authority - the Web Lock is
([ADR-0005](./0005-owner-election-via-web-locks.md)). If the cache is stale, a write is
delivered to a context that has just stopped being the owner, and that context rejects it;
this is a normal, harmless occurrence during a handover.

The write lifecycle - holding a write while ownership is in transit, and deciding what a write
that was in flight when the owner died means - lives in the context that **issued** the write,
not in the broker ([ADR-0013](./0013-write-ordering-and-delivery-semantics.md)). That context
is the only one that knows whether repeating its command is safe, and keeping the decision
there means it works identically under both transports and survives the broker itself dying.

## Alternatives considered

- **`BroadcastChannel` only, no worker.** Genuinely simpler - with Web Locks doing election
  and each sender owning its own write lifecycle, a broker is not strictly required. Rejected
  as the default because a broadcast bus puts every message in front of every tab and leaves
  the filtering to each receiver: a write result intended for one originator is seen by all,
  a payload is cloned once per tab rather than once, and a tab that is merely listening still
  pays to decode traffic addressed elsewhere. A broker makes delivery point-to-point, which is
  both cheaper and easier to reason about. It remains the fallback
  ([ADR-0007](./0007-broadcastchannel-fallback-transport.md)).
- **`localStorage` events as the bus.** Serialises everything through strings, fires only in
  _other_ tabs, has no ordering guarantee across storage partitions, and is a well-known
  source of subtle bugs. Rejected.
- **A `SharedWorker` that also elects the owner by observing port disconnects.** See
  ADR-0005: presence is not mutual exclusion.

## Consequences

### Positive

- One authoritative routing point: ordering and de-duplication are trivial to reason about.
- Presence is exact: a closed message port tells the broker immediately that a participant is
  gone, with no heartbeat and no timeout to tune.
- The broker holds no state worth losing: if it were restarted, participants re-announce
  themselves on their next message and nothing has to be recovered.

### Negative

- A `SharedWorker` needs a script URL, which makes bundling the library harder than a
  single-file drop-in: a `Blob` URL cannot be used, because each tab would produce a
  _different_ URL and therefore a different, unshared worker. The library resolves the worker
  via `new URL('./serial-broker.worker.js', import.meta.url)` and allows an explicit override
  through `configure({ workerUrl })`. This is documented prominently.
- Not available in every context (see ADR-0007), hence the fallback.

## Verification

Scenario matrix rows 3, 4, 7, 11, 12; the harness implements a real multi-context message
graph with controllable delivery order.
