# ADR-0029: Forward the worker's warnings to the tabs that are connected to it

- **Status:** Accepted, amended 2026-09-15
- **Date:** 2026-09-14
- **Amends:** ADR-0006

## Context

The library writes nothing unless an application supplies a logger, and a logger is supplied to a
tab. The `SharedWorker` has no way to reach it: it is a context of its own, started by the browser,
with no reference to anything the application configured. Its logger was therefore
`NOOP_LOGGER` - everything the worker records was written to nowhere.

What it records is exactly what an operator needs when the bus misbehaves and the tabs look healthy:
`worker.message-refused` for a message a port may not send (ADR-0024, ADR-0028),
`worker.limit-exceeded` and `broker.limit-exceeded` for what exceeds a limit,
`worker.other-protocol-version` for a tab of another build on this worker script, and
`worker.message-error` for a message that could not be cloned into the worker. Each is written once
per reason or limit, so none of them repeats on its own. Until now, `docs/site/diagnostics.md` had to
say that these records exist and that nobody sees them.

## Decision

The worker sends its `warn` and `error` records to the contexts connected to it, as a message of the
protocol, `worker-log`. A tab writes each one to its own logger, at the level the worker recorded it
at, with the worker's message and the worker's fields - its `event` among them, so the events are
the worker's own, and nothing has to be renamed to be read.

- **Every connected context receives every record, not only the one concerned.** Most of these
  records are about a port that is no participant - one that has not said `hello`, or that was
  refused - so there is often no affected tab to send them to, and where there is one it is as
  likely to be the script causing the trouble as the tab suffering it. The records are rare and
  small, an operator collects logs per tab anyway, and a deployment where only one tab has a logger
  would otherwise show nothing. A tab connected later is not told what it missed: these records
  describe the moment they were written.
- **The forwarding is bounded**: at most eight records per minute. What exceeds the budget is
  counted, and the count is reported as `worker.records-dropped` once the interval is over - on the
  next record, or at the worker's next sweep, so a count is never left waiting for a record that may
  never come. Without a bound, a script of the origin that produces a new reason per message - a
  `hello` in one protocol version after another, each answered and recorded - would turn a flood of
  its own messages into a flood of messages to every tab.
- **`debug` and `info` records stay in the worker.** They are written per message - a participant
  connecting, a message routed to no owner - and would tell a tab more about the worker than about
  its own device.
- **A record is data, never structure.** Its fields cross the bus as strings, finite numbers and
  booleans only, bounded like every other message (`MAX_LOG_RECORD_VALUES`, and
  `MAX_LOG_RECORD_CHARACTERS` for the message and the fields together); anything else the worker recorded is left out rather than making the
  record undeliverable.
- **Only the broker's own records are logged as the worker's.** The broker passes no `worker-log` on,
  no port may say `hello` as the broker (`WorkerPorts`), and a tab logs one only from the broker's
  identity. On `BroadcastChannel` there is no broker, and one posted there is dropped like every
  other message meant for a broker.

`clientId` in a forwarded record stays the identity the worker's record concerns, which is another
context than the tab writing it, or none; `reportedBy` names the tab that wrote the copy.

## Alternatives considered

- **Send the records only to the tab concerned.** Half of them concern a port that is no
  participant, and a refused message is as likely to come from the script causing the trouble as
  from the tab suffering it. Nobody would see those.
- **Let the worker collect records and hand them out on request**, through the diagnostics protocol
  (ADR-0018). It reaches an operator only while a diagnostics observer is open, and the interesting
  records are written long before anyone looks; it also makes the worker hold state, which ADR-0006
  deliberately avoids.
- **Give the worker a `console`.** A `SharedWorker`'s console output goes to its own inspector page,
  not to the page's console, and a library that writes to a console uninvited is a bad citizen
  (docs/guidelines/error-handling.md).
- **Forward every level.** The `debug` and `info` records are per message: the forwarding would
  become the bus's busiest traffic.

## Consequences

### Positive

- `worker.*` and `broker.*` records reach the logger an application configured, so a refused
  message, an exceeded limit or a stale worker script is visible where every other record is.
- The event table in `docs/site/diagnostics.md` can list them like any other event.

### Negative

- One more message type, and the protocol version is incremented (ADR-0008).
- Each record is written once per tab: a log collected from six tabs holds six copies, told apart by
  `reportedBy`.
- A tab that connects after a record was written never sees it. Only a reload of the worker - or a
  new reason - produces another.

### Risks and mitigations

- A forwarded record carries what the worker recorded, which is identities, limit names, message
  types and reasons - never a payload, and never the secret of a `hello` (ADR-0028).
- A script of the origin can cause records; the budget keeps what that costs the tabs bounded, and
  the dropped count says when it happened.

## Verification

`test/unit/worker-ports.test.ts` (records go to every connected port and to no port that is no
participant; `debug` and `info` records go nowhere; the budget holds, and what it dropped is
reported at the sweep), `test/unit/worker-script.test.ts` (a tab is told about a message that could
not be cloned, and about a tab of another protocol version), `test/unit/transports.test.ts` (a tab
logs a forwarded record as the worker's event, and ignores one that did not come from the broker),
and `test/integration/multi-tab/hostile-bus.test.ts` (both tabs log the refusal the worker recorded).

## Amendment (2026-09-15): once per key, no budget

Every warning the worker writes is written once per key - a refusal reason, a limit, the answer to a
tab of another protocol version, a message that could not be cloned - so what it forwards is bounded
by the number of keys. The interval budget (`MAX_FORWARDED_RECORDS`, `FORWARD_INTERVAL_MS`), the
count of dropped records (`worker.records-dropped`) and the separate trimming of fields are removed:
a record is forwarded only if it decodes as a tab would decode it, fields that are `undefined` left
out. The forwarding lives in `worker-ports.ts`.
