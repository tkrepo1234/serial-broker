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

## Amendment (2026-09-13): tabs notice a worker that died

### Context

Heartbeats flowed only from tab to worker. The decision above, like ADR-0006, assumed a worker that
lives as long as its tabs, and it does not always: a `SharedWorker` can crash, be ended by the
browser to reclaim memory, or be terminated from `chrome://inspect`. A port to a dead worker reports
nothing, just as a port to a dead tab reports nothing to the worker. Tabs kept posting into it, and
a transport never started a worker again, so every open tab lost coordination at once and without a
word, while tabs opened afterwards started a new worker that knew none of them. ADR-0006 said
participants "re-announce themselves" after a restart; nothing made an open tab notice one.

### Decision

1. The broker answers every heartbeat with a `welcome` addressed to its sender: the message it
   already sends in answer to `hello`, which the transport keeps to itself. No message type was
   added, but a tab now depends on the answer, so the protocol version went from 4 to 5.
2. At each heartbeat a tab checks whether anything valid has arrived from the broker since the
   previous one; any message counts, not only answers. After `MAX_UNANSWERED_HEARTBEATS` (3) in a
   row without, it gives up on the worker:
   - If a broker of its version had answered before, the tab reports the loss once, which the
     client reports as `BROKER_UNAVAILABLE`. It closes its port, starts a new `SharedWorker` with
     the same URL and name, and sends `hello` and at once a heartbeat. The heartbeat restores what
     the tab takes part in and owns, exactly as it restores a tab the broker forgot. No
     `owner-claimed` is sent: that would tell every other tab that the port changed hands, which it
     did not. If the new worker stays silent too, the tab tries again three heartbeats later, and
     reports a loss again only once a broker has answered in between.
   - If none ever answered and the tab can still fall back, the worker is treated like one whose
     script did not load (ADR-0007, ADR-0024): what the tab sent is replayed over
     `BroadcastChannel`, and `environment.transport-fallback` is logged with
     `reason: 'worker-not-answering'`. That also bounds the record kept for the replay in time:
     beyond the traffic limit it had no bound while the worker stayed silent.
3. The count is of heartbeats, not of time, because of throttling. A browser holds back the timers
   of a hidden tab to about one run a minute. Such a tab sends fewer heartbeats, but the broker
   answers each of them at once, and message delivery is not throttled, so throttling can delay a
   verdict and never cause one. A long task in the tab can delay an answer past the next heartbeat
   once, not three times running. A dead worker is therefore noticed 45 to 60 seconds after its last
   answer in a visible tab, and within about four minutes in a throttled one.

### Alternatives considered

- **Fall back to `BroadcastChannel` instead of starting a new worker.** Every open tab would move,
  but tabs opened later start a new worker and would not hear them: the partition made permanent.
- **Measure the silence in time.** A timeout short enough to matter fires for every throttled tab;
  one long enough not to leaves visible tabs cut off for minutes.
- **A Web Lock the worker holds for its lifetime, which tabs wait for.** The browser releases it the
  moment the worker dies, so it is exact and immune to throttling. Not chosen for the same reasons
  as the per-tab lock above, and it would still need the reconnect described here. It remains the
  upgrade path.

### Consequences

- A worker that dies no longer cuts tabs off for good: within about a minute every visible tab is on
  one new worker, together with any tab opened since.
- One more message per tab every 15 seconds, from the worker.
- Between the death and each tab's reconnect, messages are lost in both directions: traffic, status
  changes, and write requests, which end in `WRITE_TIMEOUT` because their deadline covers the whole
  journey (ADR-0013). Tabs reconnect independently, hidden ones later.
- Nothing above the transport learns of the reconnect, so nothing lost is asked for again. A tab
  that reaches the new worker before the owner does asks for the status into a broker that knows no
  owner, and nobody repeats it; see `BACKLOG.md`.
- A worker script that loads more than 45 seconds after a tab started it finds that tab already on
  `BroadcastChannel`, and tabs opened later on the worker: the partition described in ADR-0007's
  amendment.

### Verification

`test/unit/worker-transport-liveness.test.ts`, `test/unit/broker.test.ts`,
`test/unit/worker-script.test.ts` and `test/integration/multi-tab/worker-restart.test.ts`; manual
test plan step 29.

### Note (2026-09-14): the worker ends with the tab that started it

The browser benchmark (ADR-0036) found that the death this amendment handles is not rare. In
Microsoft Edge 153 on Windows 11, the `SharedWorker` ended when the renderer of the page that
started it crashed, and it survived the crash of any other page. That page is usually also the
first to hold the port. The tab that takes the port over reports `open` as soon as the browser
frees the lock, but every other tab stays `reconnecting` until its heartbeats give up on the worker:
60 seconds in the measurement, with a write issued meanwhile ending in `WRITE_TIMEOUT`. The lock the
worker holds for its lifetime, listed above as the upgrade path, would bring that down to the time
the browser takes to free a lock. Until then it is a documented limit (`docs/site/performance.md`).
