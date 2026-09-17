# ADR-0041: Tell who is still there through Web Locks, not heartbeats

- **Status:** Accepted
- **Date:** 2026-09-15

## Context

A `MessagePort` reports nothing when the context at its other end goes away, in either direction.
The broker never learns that a tab crashed, was killed or had its renderer discarded; posting to its
port does not even throw. And a `SharedWorker` can end while its tabs live: it can crash, be ended by
the browser to reclaim memory, or be terminated from `chrome://inspect`. The browser benchmark
([ADR-0037](./0037-measure-performance-against-expectations-written-first.md)) found that in
Microsoft Edge the worker ends with the renderer of the page that started it - usually the first tab
to hold the port.

Heartbeats answer both directions: a message from every tab every 15 seconds, answered by the
worker, a sweep forgetting tabs silent for three minutes, and a new worker after three unanswered
heartbeats. They cost traffic while nothing happens, and they are slow where it matters. Measured
with them: after the worker ended, every tab but the new holder stayed `reconnecting` for 60
seconds - four minutes in a hidden tab - and a write sent meanwhile ended in `WRITE_TIMEOUT`, 240
times the expectation. A timeout short enough to matter would fire for every hidden tab, whose
timers the browser throttles.

What the whole library already rests on answers it exactly ([ADR-0005](./0005-owner-election-via-web-locks.md)):
the browser lets go of a context's locks when the context goes, however it goes, and grants the lock
to whoever waits. `navigator.locks` is exposed to workers in every browser that has Web Serial.

## Decision

**Liveness is Web Locks, in both directions. No message is sent to show that anyone is there.**

1. **A context holds a lock for its lifetime.** A `SharedWorker` transport requests
   `serial-broker/context/v<protocol>/<clientId>` when it is created and holds it until it is
   closed. It says `hello` only once it holds it, and keeps what it sends until then, so that the
   worker's request on the lock can only queue behind it.
2. **The worker waits on it.** When the worker first registers an identity, it requests that lock in
   shared mode. The grant means the context has gone - closed, crashed, discarded - and the worker
   forgets the identity and lets the lock go. A message still on its way from that context registers
   it again, and the next grant, immediate, forgets it again. Closing a transport lets the lock go,
   which tells the worker at once; there is no `goodbye`.
3. **The worker holds a lock for its lifetime**, named after an identity it makes up when it starts,
   `serial-broker/worker/v<protocol>/<workerId>`, and its `welcome` names it. The worker starts no
   port before it holds the lock, so no tab can be welcomed to a worker whose end the browser could
   not announce, and a second worker - one started from another script URL - holds a lock of its own.
4. **Tabs wait on it.** After a `welcome`, a tab requests the worker's lock in shared mode. The grant
   means the worker has ended: the tab reports `BROKER_UNAVAILABLE` once, with `isRetryable: true`,
   logs `transport.worker-restarted`, starts a new `SharedWorker` and says `hello` there, which
   restores everything it takes part in. The client restates what the other tabs need to know - the
   holder its status, every other tab a request for it.
5. **One timer is left: the handshake deadline.** A worker whose script fetch hangs, or that cannot
   take its lock, holds no lock to free. A tab that has no `welcome` 45 seconds
   (`HANDSHAKE_DEADLINE_MS`) after starting a worker gives up on it: before any `welcome`, it moves to
   `BroadcastChannel` ([ADR-0006](./0006-sharedworker-as-message-broker.md)); after a lost worker, it
   starts another. Only whether the welcome has arrived is checked, so a throttled timer cannot cause
   the verdict.
6. **`hello` says what a tab takes part in.** It carries every configuration name and is sent again
   whenever that changes, in place of separate attach and detach messages.
7. **The `BroadcastChannel` transport needs none of this.** It keeps no state about other tabs that
   would need forgetting, and has no worker to lose.

## Alternatives considered

- **Heartbeats with a sweep in the worker and a count of unanswered heartbeats in the tabs.**
  Rejected for the cost and the delay above.
- **Keep the heartbeats and shorten the timeouts.** A timeout short enough to matter fires for every
  throttled tab, and every hidden tab is throttled.
- **Close the port of a silent participant.** A tab that was only throttled would lose its connection
  to the worker for good.
- **Fall back to `BroadcastChannel` instead of starting a new worker when the worker ends.** Tabs
  opened later start a new worker and would not hear the ones that moved: the partition made
  permanent.
- **Only the worker's lock, keeping the heartbeats for tabs.** Fixes the stall but keeps the sweep,
  the heartbeat message and minutes of dead tabs in the worker's tables.
- **A lock name without a worker identity.** Every worker of a protocol version would hold the same
  lock, so a worker started from a second script URL would wait behind the first forever.
- **Welcome at once and wait for the worker's lock afterwards.** The worker's request and a tab's
  travel to the browser on different channels, so a tab could be granted the lock before the worker
  holds it and take a running worker for a dead one.

## Consequences

### Positive

- A tab learns that the worker ended as soon as the browser frees the worker's lock; the 60-second
  stall is gone (`docs/site/performance.md`).
- The worker forgets a tab the moment it has gone.
- Nothing crosses the bus while nothing happens: an idle week costs no message.
- A throttled, frozen or sleeping tab is never forgotten and taken back: its lock is held.

### Negative

- Two more locks per tab in what `navigator.locks.query()` and the diagnostics observer list: the
  tab's own and its request on the worker's; and one request per tab by the worker.
- A worker that hangs after it welcomed a tab - alive, holding its lock, answering nothing - is not
  noticed. A `SharedWorker` runs no application code, and nothing in it loops.
- Between a worker's end and each tab reaching the new one, messages are lost in both directions;
  a write issued then ends in `WRITE_TIMEOUT` if the new worker is not reached before its deadline.
- A tab whose own lock request the browser refuses says hello anyway, and the worker forgets it
  again once its request is granted; such a browser refuses the ownership lock as well.

### Risks and mitigations

- A script of the origin that holds a tab's or a worker's lock name, or queues on it first, keeps
  the worker from forgetting that tab, or tabs from noticing that worker's end. Such a script can
  hold every lock this library uses (`SECURITY.md`); what it can make the worker keep stays bounded
  by `MAX_PARTICIPANTS`.

## Verification

`test/unit/worker-ports.test.ts`, `test/unit/worker-script.test.ts`,
`test/unit/worker-transport-liveness.test.ts`, `test/unit/transports.test.ts`,
`test/integration/multi-tab/shared-worker.test.ts` (tabs that go away, and a worker that dies)
and the harness conformance test that a terminated worker's lock is let go. In a real browser,
`test/browser/failover.spec.ts` "the broker dies" terminates the `SharedWorker` and every tab is on a
new one within the default wait, and the browser benchmark's `handover/crash`.
