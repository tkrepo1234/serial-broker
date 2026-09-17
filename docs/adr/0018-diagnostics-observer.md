# ADR-0018: Expose coordination internals to operators through a diagnostics observer

- **Status:** Accepted

## Context

[ADR-0011](./0011-encapsulation-boundary.md) keeps every trace of the coordination mechanism
out of the public API: no owner identity, no participant count, no lock state, no transport.
Its reasoning holds for **application code** — anything observable becomes load-bearing,
and code that branches on "am I the owner?" is a race.

It leaves one audience unserved. An **operator** looking at a deployment — a support engineer, a
developer on a shop floor, the person who owns the machine — has questions ADR-0011 makes
unanswerable: which tab holds the port, whether the owner is reconnecting and when it tries
next, whether a tab is sitting on writes that never went out, whether every tab even runs the
same settings. A logger has to be enabled in advance, in every tab, in the application's own code.

The people running a deployment need a debugging surface shipped with the library that shows every
setting and every piece of status.

Three facts shape how that can be built:

- **The facade is a module-level singleton.** A second entry point that read its state would
  share nothing with it as soon as the two entry points were bundled separately.
- **The message bus reaches every context of the origin**, from any page, with no
  cooperation from the application beyond using the library.
- **The worker can reach no logger.** A `SharedWorker` is a context of its own, started by the
  browser, and the logger an application configured belongs to a tab. What the worker records -
  a refused message, an exceeded limit, a tab of another build - would be written to nowhere.

## Decision

Diagnostics are a **separate, read-only entry point, `serial-broker/diagnostics`**, built on a
**diagnostics observer**: a context that joins the message bus under its own identity but sets
up no configuration, requests no Web Lock, and never answers for a port.

- **Collecting.** The observer broadcasts `diagnostics-request` to every context on the bus. Each
  context that has at least one configuration answers the observer with a `diagnostics-report`:
  its transport, and per configuration its role, status, effective settings, listener counts and
  pending writes, plus — in the tab holding the port — the supervisor's connection state, attempt
  count, next scheduled attempt, queued writes, a stalled write and byte counters. Nothing announces
  how many contexts exist, so a collection listens for a fixed window (500 ms by default). The
  observer also lists this library's Web Locks through `LockManager.query()` where the browser
  offers it.
- **Watching.** The observer can join a configuration's broadcasts — and only its broadcasts —
  to stream traffic, status changes, errors and ownership changes as they cross the bus.
- **Bounded.** A context answers `diagnostics-request` only within `DIAGNOSTICS_ANSWER_RATE`, and one
  collection keeps at most `MAX_REPORTS_PER_COLLECTION` reports and
  `MAX_REPORT_CHARACTERS_PER_COLLECTION` characters: the request id is broadcast, so anything on the
  bus can answer it under as many identities as it invents. The values are in
  [ADR-0031](./0031-bound-and-rate-limit-what-the-bus-can-cost-a-tab.md).
- **A report is filed, not validated in full.** It is only ever displayed, and the decoder already
  holds it to its structure budget. Only what files it is checked - the sender, its transport,
  version and time, and that its configurations are a list of named entries. What displays a report
  reads it defensively.
- **The worker's warnings reach the tabs.** The worker sends its `warn` and `error` records to every
  connected context as `worker-log`, and each tab writes them to its own logger at the recorded
  level, under the worker's own events (`worker.message-refused`, `worker.limit-exceeded`,
  `broker.limit-exceeded`, `worker.other-protocol-version`, `worker.message-error`,
  `worker.lock-failed`). Every warning is written once per key, so what is forwarded is bounded
  without a budget; a record is forwarded only if it decodes as a tab would decode it. `debug` and
  `info` records stay in the worker. A tab logs a `worker-log` only from the broker's identity;
  `clientId` in it stays the identity the record concerns, and `reportedBy` names the tab that wrote
  the copy.
- **The main entry point carries none of it.** `getStatus()`, the events and every payload have
  exactly the keys ADR-0011 pins, and a test asserts that nothing diagnostic is exported from it.

This is the one deliberate exception to ADR-0011, and it is an exception for operators, not for
application code.

## Alternatives considered

- **Diagnostics on the main facade** (`SerialBroker.inspect(name)`). The simplest to build, and
  the one ADR-0011 exists to prevent: it puts "who owns the port" one autocomplete away from
  application code. Rejected.
- **A second entry point reading the facade's singleton.** Hidden coupling, and broken outright
  when the entry points are bundled separately. Rejected.
- **Asking the broker instead of the contexts.** The broker knows participants, but nothing about
  connections, writes or settings, and the `BroadcastChannel` fallback has no broker at all.
- **A diagnostics page that is a full participant.** It would see only its own view, and it would
  join the election: close the application's tabs and the port moves to the page that was only
  meant to be watching.
- **Logger only.** Requires enabling in advance, in the application's code, in every tab, and
  produces a stream rather than a state. Kept as the complement, not the answer.
- **Validate every field of a report on arrival.** Some 150 lines repeating the report's type, for
  data that is only displayed.
- **Send the worker's records only to the tab concerned.** Half of them concern a port that is no
  participant, and a refused message is as likely to come from the script causing the trouble as
  from the tab suffering it.
- **Let the worker hold its records and hand them out on request.** Reaches an operator only while
  an observer is open, and makes the worker hold state ([ADR-0006](./0006-sharedworker-as-message-broker.md)).
- **Give the worker a `console`, or forward every level.** A worker's console goes to its own
  inspector page; `debug` and `info` are per message and would become the bus's busiest traffic.
- **An interval budget for forwarded records.** Writing each warning once per key bounds the same
  thing with less code.

## Consequences

### Positive

- An operator can see every tab of an origin, every configuration and every setting from one
  page, without changing the application and without disturbing ownership.
- The state that decides failover and the write guarantee is inspectable in a real browser, which
  also makes the manual test plan checkable rather than inferred.
- A refused message, an exceeded limit or a stale worker script is visible in the application's
  logger, where every other record is.

### Negative

- The internals described in a report become visible, and anything visible attracts dependence.
  Mitigated by the separate entry point and the documentation; not prevented.
- A collection is a window, not a transaction: a tab that answers late is missing from it, and
  every report is stale on arrival. A legitimate burst beyond the answer rate gets fewer answers.
- Reports describe traffic volume and pending writes, never payload bytes; the watch stream does
  carry payloads, exactly as every participant receives them.
- Each forwarded worker record is written once per tab, told apart by `reportedBy`, and a tab that
  connects after a record was written never sees it.

## Verification

- `test/integration/multi-tab/diagnostics-observer.test.ts`, on both transports: reports from every
  tab with roles and settings, the owner's connection state, pending writes, listener counts, lock
  listing, streamed events, that observing never changes who owns the port, and a collection
  answered under invented identities held to its bounds.
- `test/unit/decode-matrix.test.ts` (`isParticipantDiagnostics` and the decode matrix): a report
  that cannot be filed is rejected.
- `test/unit/worker-ports.test.ts` and `test/unit/transports.test.ts`: records go to every connected
  port, `debug` and `info` go nowhere, and a tab logs a forwarded record only from the broker.
- `test/integration/encapsulation.test.ts`: the main entry point exports nothing diagnostic.
