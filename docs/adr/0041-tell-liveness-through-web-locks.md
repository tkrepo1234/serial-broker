# ADR-0041: Tell who is still there through Web Locks, not heartbeats

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes:** [ADR-0021](./0021-forget-silent-participants.md)
- **Amends:** ADR-0006, ADR-0007, ADR-0024

## Context

A `MessagePort` reports nothing when the context at its other end goes away, in either direction.
ADR-0021 answered this with heartbeats: every tab on the `SharedWorker` sent one every 15 seconds,
the worker answered each and forgot a tab silent for three minutes, and a tab whose last three
heartbeats went unanswered started a new worker. It cost a message and an answer per tab every 15
seconds, a sweep in the worker, a count of unanswered heartbeats in every tab, and a restore path
through the heartbeat.

It was also slow where it mattered. The browser benchmark (ADR-0037) found that in Microsoft Edge
the worker ends with the renderer of the page that started it, usually the first tab to hold the
port. Every other tab then stayed `reconnecting` for 60 seconds - four minutes in a hidden tab -
until its heartbeats gave up, and a write sent meanwhile ended in `WRITE_TIMEOUT`: 240 times the
expectation. ADR-0021 named its own upgrade path twice: a Web Lock per tab that the worker waits on,
and a Web Lock the worker holds for its lifetime that the tabs wait on. Both rest on what the whole
library already rests on (ADR-0005): the browser lets go of a context's locks when the context goes,
however it goes, and grants the lock to whoever waits.

`navigator.locks` is exposed to workers in every browser that has Web Serial.

## Decision

**Liveness is Web Locks, in both directions. No message is sent to show that anyone is there.**

1. **A context holds a lock for its lifetime.** A `SharedWorker` transport requests
   `serial-broker/context/v<N>/<clientId>` when it is created and holds it until it is closed. It says
   `hello` only once it holds it, and keeps what it sends until then, so that the worker's request
   on the lock can only queue behind it.
2. **The worker waits on it.** When the worker first registers an identity, it requests that lock in
   shared mode. The grant means the context has gone - closed, crashed, discarded - and the worker
   forgets the identity and lets the lock go. A message still on its way from that context registers
   it again, and the next grant, immediate, forgets it again. `goodbye` is gone: closing the
   transport lets the lock go, which tells the worker at once.
3. **The worker holds a lock for its lifetime.** It is named after an identity the worker makes up
   when it starts, `serial-broker/worker/v<N>/<workerId>`, and the `welcome` names it. The worker
   starts no port before it holds the lock, so no tab can be welcomed to a worker whose end the
   browser could not announce, and a second worker - one started from another script URL - holds a
   lock of its own.
4. **Tabs wait on it.** After a `welcome`, a tab requests the worker's lock in shared mode. The grant
   means the worker has ended: the tab reports `BROKER_UNAVAILABLE` once, with `isRetryable: true`,
   starts a new `SharedWorker` and says `hello` there, which restores everything it takes part in.
   The client restates what the other tabs need to know, as before.
5. **One timer is left: the handshake deadline.** A worker whose script fetch hangs, or that cannot
   take its lock, holds no lock to free. A tab that has no `welcome` 45 seconds after starting a
   worker gives up on it: before any `welcome`, it moves to `BroadcastChannel` (ADR-0007); after a
   lost worker, it starts another. Only whether the welcome has arrived is checked, so a throttled
   timer cannot cause the verdict.
6. **`hello` says what a tab takes part in.** It carries every configuration name and is sent again
   whenever that changes, replacing `attach` and `detach`; the broker takes each `hello` for the
   whole of the sender's participation. With `heartbeat` and `goodbye` also gone, the vocabulary goes
   from 19 message types to 15. The protocol version went from 11 to 12.
7. **The `BroadcastChannel` transport is unchanged.** It never sent heartbeats, and it keeps no state
   about other tabs that would need forgetting.

## Alternatives considered

- **Keep the heartbeats and shorten the timeouts.** A timeout short enough to matter fires for every
  throttled tab, and every hidden tab is throttled.
- **Only the worker's lock, keeping the heartbeats for tabs.** Fixes the stall but keeps the sweep,
  the heartbeat message and three minutes of dead tabs in the worker's tables.
- **A lock name without a worker identity.** Every worker of a protocol version would hold the same
  lock, so a worker started from a second script URL would wait behind the first forever, and tabs
  of the second could take the first's end for their own worker's.
- **Welcome at once and wait for the worker's lock afterwards.** The worker's request and a tab's
  travel to the browser on different channels, so a tab could be granted the lock before the worker
  holds it and take a running worker for a dead one. Starting ports only once the lock is held costs
  nothing a tab would notice.

## Consequences

### Positive

- A tab learns that the worker ended as soon as the browser frees the worker's lock. The benchmark
  stall of 60 seconds is gone (see `docs/site/performance.md`).
- The worker forgets a tab the moment it has gone, not three and a half minutes later.
- Nothing crosses the bus while nothing happens: an idle week costs no message.
- A throttled, frozen or sleeping tab is no longer forgotten and taken back: its lock is held.
- Less code: no heartbeat timer, no sweep, no count of unanswered heartbeats, four message types
  fewer.

### Negative

- Two more locks per tab in what `navigator.locks.query()` and the diagnostics observer list: the
  tab's own and its request on the worker's; and one request per tab by the worker.
- A worker that hangs after it welcomed a tab - alive, holding its lock, answering nothing - is not
  noticed. The heartbeats noticed it. A `SharedWorker` runs no application code, and nothing in it
  loops.
- A tab whose own lock request the browser refuses says hello anyway, and the worker forgets it
  again once its request is granted; such a browser refuses the ownership lock as well.

### Risks and mitigations

- A script of the origin that holds a tab's or a worker's lock name, or queues on it first, keeps the
  worker from forgetting that tab, or tabs from noticing that worker's end. Such a script can hold
  every lock this library uses (`SECURITY.md`); what it can make the worker keep stays bounded by
  `MAX_PARTICIPANTS`.

## Verification

`test/unit/worker-ports.test.ts`, `test/unit/worker-script.test.ts`,
`test/unit/worker-transport-liveness.test.ts`, `test/unit/transports.test.ts`,
`test/integration/multi-tab/departed-tabs.test.ts`, `test/integration/multi-tab/worker-restart.test.ts`
and the harness conformance test that a terminated worker's lock is let go. In a real browser,
`test/browser/failover.spec.ts` "the broker dies" terminates the `SharedWorker` and every tab is on a
new one within the default wait, and the browser benchmark's `handover/crash`.
