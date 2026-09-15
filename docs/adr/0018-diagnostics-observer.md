# ADR-0018: Expose coordination internals to operators through a diagnostics observer

- **Status:** Accepted, amended by [ADR-0031](./0031-bound-and-rate-limit-what-the-bus-can-cost-a-tab.md)
- **Date:** 2026-09-13
- **Amends:** [ADR-0011](./0011-encapsulation-boundary.md)

> **Amendment (ADR-0031).** A context answers `diagnostics-request` only within a rate, and one
> collection keeps at most `MAX_REPORTS_PER_COLLECTION` reports: a request id is broadcast, so
> anything on the bus can answer it under as many identities as it invents.

## Context

[ADR-0011](./0011-encapsulation-boundary.md) keeps every trace of the coordination mechanism
out of the public API: no owner identity, no participant count, no lock state, no transport.
Its reasoning still holds for **application code** — anything observable becomes load-bearing,
and code that branches on "am I the owner?" is a race.

It left one audience unserved. An **operator** looking at a deployment — a support engineer, a
developer on a shop floor, the person who owns the machine — has questions ADR-0011 makes
unanswerable: which tab holds the port, whether the owner is reconnecting and when it tries
next, whether a tab is sitting on writes that never went out, whether every tab even runs the
same settings. The only channel ADR-0011 left is the opt-in logger, which has to be enabled in
advance, in every tab, in the application's own code.

The requirement (2026-09-13) is a debugging surface shipped with the library that shows every
setting and every piece of status, for transparency towards the people running it.

Two facts shape how that can be built:

- **The facade is a module-level singleton.** A second entry point that read its state would
  share nothing with it as soon as the two entry points were bundled separately, which is the
  normal case for a separately published entry point.
- **The message bus already reaches every context of the origin**, from any page, with no
  cooperation from the application beyond using the library.

## Decision

Diagnostics are a **separate, read-only entry point, `serial-broker/diagnostics`**, built on a
**diagnostics observer**: a context that joins the message bus under its own identity but sets
up no configuration, requests no Web Lock, and never answers for a port.

- **Collecting.** The observer broadcasts `diagnostics-request` to every context on the bus. Each
  context that has at least one configuration answers the observer with a
  `diagnostics-report`: its transport, and per configuration its role, status, effective
  settings, listener counts and pending writes, plus — in the owner — the supervisor's
  connection state, attempt count, next scheduled attempt, queued writes and byte counters.
  Nothing announces how many contexts exist, so a collection listens for a fixed window
  (500 ms by default). The observer also lists this library's Web Locks through
  `LockManager.query()` where the browser offers it.
- **Watching.** The observer can join a configuration's broadcasts — and only its broadcasts —
  to stream traffic, status changes, errors and ownership changes as they cross the bus.
- **The main entry point does not change.** `getStatus()`, the four events and every payload keep
  exactly the keys ADR-0011 pinned, and a test asserts that nothing diagnostic is exported from
  it.
- **The wire protocol goes to version 2**, for the two new messages. The broker delivers a
  `diagnostics-request` to every connected context, attached to a configuration or not; the
  `BroadcastChannel` fallback already delivers configuration-less broadcasts to everyone. A
  report is validated in full on arrival, like every other message (amended below).

ADR-0011 is amended, not superseded: its boundary stands for the application-facing API, and
this record adds the one deliberate exception and the reason it is an exception.

## Alternatives considered

- **Diagnostics on the main facade** (`SerialBroker.inspect(name)`). The simplest to build, and
  the one ADR-0011 exists to prevent: it puts "who owns the port" one autocomplete away from
  application code. Rejected.
- **A second entry point reading the facade's singleton.** Hidden coupling, and broken outright
  when the entry points are bundled separately — each bundle gets its own singleton, and the
  diagnostics one sees an empty library. A global registry would paper over that at the cost of
  a hidden global. Rejected.
- **Asking the broker instead of the contexts.** The broker knows participants and the claimed
  owner, but nothing about connections, writes or settings, and the `BroadcastChannel` fallback
  has no broker at all. Rejected.
- **A diagnostics page that is a full participant** — sets the configuration up and reads its
  own state. It would see only its own view, and it would join the election: close the
  application's tabs and the port moves to the page that was only meant to be watching.
  Rejected; the page can still set configurations up deliberately, through the public API.
- **Logger only.** What ADR-0011 left. Requires enabling in advance, in the application's code,
  in every tab, and produces a stream rather than a state. Kept as the complement, not the answer.

## Consequences

### Positive

- An operator can see every tab of an origin, every configuration and every setting from one
  page, without changing the application and without disturbing ownership.
- The state that decides failover and the write guarantee — roles, started writes, reconnect
  timing — is inspectable in a real browser, which also makes the manual test plan checkable
  rather than inferred.

### Negative

- The internals described in a report become visible, and anything visible attracts
  dependence. Mitigated by the separate entry point, by the documentation, and by allowing report
  types to grow in minor releases; not prevented.
- Protocol version 2 partitions from version 1 (ADR-0008). Version 1 was never released.
- A collection is a window, not a transaction: a tab that answers late is missing from it, and
  every report is stale on arrival.
- Reports describe traffic volume and pending writes, never payload bytes; the watch stream does
  carry payloads, exactly as every participant already receives them. A page that uses it sees
  what the device says. That is the purpose of a debugging surface, and why it is not in the main
  entry point.

## Verification

- `test/integration/multi-tab/diagnostics-observer.test.ts`, on both transports: reports from
  every tab with roles and settings, the owner's connection state, pending writes, listener
  counts, lock listing, streamed events — and that observing never changes who owns the port.
- `test/unit/decode-diagnostics.test.ts` and the decode matrix: a report that cannot be filed is
  rejected (see the amendment below).
- `test/integration/encapsulation.test.ts`: the main entry point exports nothing diagnostic.

## Amendment (2026-09-15): a report is filed, not validated in full

A report used to be checked field by field on arrival, in some 150 lines that repeated its type. It
is only ever displayed, and the decoder already holds it to its structure budget: a tree of plain
values of bounded size. So only what files it is checked now - the sender, its transport, version and
time, and that its configurations are a list of named entries. Below that, a report says what its
context sent, which may be a build that reports differently, and what displays it reads it
defensively: the debugging surface leaves the other tabs' reports out until the next collection when
one cannot be shown. A collection keeps the contexts it has heard from in a set.
