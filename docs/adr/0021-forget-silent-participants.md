# ADR-0021: Forget tabs that stop sending heartbeats

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

The broker in the `SharedWorker` keeps, per configuration, which tabs take part and which tab last
claimed the port (ADR-0006). It forgets a tab when the tab says `goodbye`. A tab that crashes, is
killed or has its renderer discarded says nothing, and a `MessagePort` has no close event: posting
to the port of a dead tab does not even throw.

Such a tab therefore stayed in the broker for as long as the worker lived. Correctness did not
depend on it - ownership is the Web Lock, released by the browser the moment the tab dies, and the
successor's `owner-claimed` replaces the dead owner (ADR-0005) - but every dead tab stayed in the
participant lists, received broadcasts into a port nobody reads, and was asked for diagnostics
reports it never sent. Over a long working day on a shop floor, tabs come and go by the dozen.

The test harness hid this: killing a simulated tab told the broker, which a real worker never
learns.

## Decision

Every participant on the `SharedWorker` sends a `heartbeat` every 15 seconds. The broker records
when it last heard anything from each participant - any message counts - and every 30 seconds
forgets the participants it has not heard from for three minutes.

The heartbeat carries the configurations the sender takes part in and the ones whose port it
holds. The broker applies it idempotently: it adds the sender to those configurations and, where
the broker knows no owner for one of them, records the sender as its owner. It never replaces an
owner it knows, because a heartbeat can be older than a successor's claim, and the Web Lock - not
the broker - decides who owns a port.

The worker only drops a forgotten participant's port from its tables; it never closes it.

The timeout is long on purpose. Browsers throttle the timers of a tab hidden for a while to about
one run a minute, and such a tab is alive. If it is forgotten anyway, its next heartbeat restores
its participation and, while no other tab has claimed the port, its ownership. Adding the message
changed the message shapes, so the protocol version went from 3 to 4 (ADR-0008).

The `BroadcastChannel` fallback has no broker and no state to go stale, so it sends no heartbeats.

## Alternatives considered

- **A Web Lock per tab that the worker waits for.** Each tab holds `serial-broker/tab/<id>` for
  its lifetime; the worker requests the same lock and is granted it when the tab dies. Exact and
  immediate, and immune to throttling. Not chosen for now: it depends on the Web Locks API inside
  the worker, adds one lock per tab to what operators see in the lock list, and a heartbeat is
  easier to reason about and to simulate. It remains the upgrade path if three minutes turns out
  to be too slow.
- **Closing the port of a silent participant.** Frees the port at once, but a tab that was only
  throttled would lose its connection to the worker for good, with no way to rejoin.
- **A short timeout.** Cleans up faster, and forgets every background tab whose timers the browser
  throttles - repeatedly, as each heartbeat restores it and the next sweep drops it again.

## Consequences

### Positive

- A dead tab is forgotten within three and a half minutes of its last message.
- The simulation now matches the browser: a killed tab neither tells the broker nor sends anything,
  and the broker learns of it only when its heartbeats stop.
- A heartbeat also repairs any divergence between a tab and the broker, whatever caused it.

### Negative

- A heartbeat message every 15 seconds per tab. At the message rates of a serial port this is
  noise.
- For up to three minutes a dead tab still receives broadcasts, as before.
- A throttled tab can be forgotten and restored. Between the two, broadcasts do not reach it; data
  it misses is lost, as it would be during an ownership handover (see "How shared ports behave").

## Verification

`test/unit/broker.test.ts`, `test/unit/transports.test.ts`, `test/unit/worker-script.test.ts` and
`test/integration/multi-tab/heartbeat.test.ts`.
