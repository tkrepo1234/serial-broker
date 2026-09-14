# ADR-0025: Limit how many tabs use a configuration at once

- **Status:** Accepted, amended by [ADR-0030](./0030-hold-a-web-lock-for-every-term-of-holding-the-port.md)
- **Date:** 2026-09-13
- **Amends:** ADR-0011

> **Amendment (ADR-0030).** The tab limit of the tab holding the port is part of the name of that
> term's Web Lock, and `owner-claimed` carries it as `status` does. A tab therefore withdraws only
> for a limit the tab holding the port demonstrably runs, never for one a message claims.

## Context

serial-broker lets every tab of an origin use a port. Some applications need the opposite as well:
a device that only one tab may drive at a time - a machine operated from one screen - or at most a
few. The tabs beyond that should not fail for good; they should wait and take over as soon as a tab
lets go, including a tab that crashed.

Tabs of other origins and other programs cannot be counted: they share neither Web Locks nor the
message bus. A port they hold already makes `open()` fail, and the owner retries until it is free.

Web Locks offer an exclusive lock and a shared one, but no lock that `n` holders may share. The
broker knows the tabs attached to a configuration, but the `BroadcastChannel` fallback has none, and
the broker notices a dead tab only after three minutes of silence (ADR-0021).

## Decision

A configuration takes `maxTabs`: an integer from 1 to 100, or `Infinity`, the default.

With a limit, a tab joins the bus and the ownership election only while it holds one of `maxTabs`
**places**, each a Web Lock named `serial-broker/tab-slot/v<protocol>/<maxTabs>/<place>/<name>`.
Until then its status is the new value `queued`: it receives nothing, and its writes wait for their
deadline.

Web Locks cannot wait for any one of several locks, so a tab first takes a **gate** lock,
`serial-broker/tab-slot-gate/v<protocol>/<maxTabs>/<name>`, and only while holding it requests every
place at once. The first place granted is kept; the other requests are aborted, a place granted in
the same moment is returned at once, and the gate is released. Waiting tabs queue at the gate, so
they are admitted in the order they arrived. A tab gives its place up last when it releases the
configuration, after leaving the port and the bus; the browser gives it up when the tab dies.

Every tab has to use the same limit. The limit is part of the lock names, so tabs that disagree hold
separate sets of places, and the tab holding the port sends its limit with every `status` message.
A tab that hears a different limit reports `CONFIGURATION_CONFLICT` to every tab, leaves the
election, the bus and its place, and stays `failed` until the application releases the
configuration and sets it up with the same limit. The tab holding the port decides. The `status`
message gains `maxTabs`, so the protocol version becomes 6.

ADR-0011 withholds everything about coordination from the application. `queued` is an exception by
request: it says that the limit the application itself set is reached, and still nothing about
which tab holds the port.

## Alternatives considered

- **Count the tabs in the broker.** Exact while the worker lives, but the `BroadcastChannel`
  fallback has no broker, a dead tab is counted for three minutes, and a restarted worker knows
  nobody.
- **Poll the places with `ifAvailable`.** No queue order, and a timer in every waiting tab.
- **Reject a tab beyond the limit.** Simpler, but every application would have to retry, and the
  tab that should take over after a crash would have to notice it. Tim chose waiting.
- **Leave differing limits to documentation**, as for the other options. Two tabs with different
  limits would jointly exceed both, which defeats a limit meant to guarantee exclusive use.

## Consequences

### Positive

- A place is freed however its tab goes away, by the browser, exactly as ownership is (ADR-0005).
- Identical on both transports: the places are Web Locks, not bus messages.
- Without a limit nothing changes: no places, no gate, no extra messages.

### Negative

- A waiting tab holds the gate and has `maxTabs` lock requests queued; hence the upper bound of 100.
- Which limit wins a disagreement depends on which tab holds the port. A tab with a different limit
  that becomes the owner first makes the others withdraw.
- Only tabs of the same origin are counted.

### Risks and mitigations

- A write issued while queued fails with `WRITE_TIMEOUT` rather than waiting indefinitely; the
  status `queued` tells the application why.

## Verification

`test/unit/tab-slot.test.ts` (places, queue order, a dying holder, leaving the queue) and
`test/integration/multi-tab/tab-limit.test.ts` (in both transport modes: waiting and admission after
a release and after a crash, the tab holding the port counted, writes while queued, a differing
limit, validation, storage).
