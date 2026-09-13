# ADR-0007: Fall back to BroadcastChannel when SharedWorker is unavailable

- **Status:** Accepted, amended by [ADR-0024](./0024-keep-the-worker-handshake-version-independent.md)
- **Date:** 2026-09-12

> **Note (2026-09-13).** "The shared broker core keeps the duplication small" no longer holds: the
> `BroadcastChannel` transport uses no broker code. Each tab decides from the envelope whether a
> message is for it, and what both transports share is the sending half (`message-sender.ts`).

## Context

`SharedWorker` is not universally available even where Web Serial is. It is absent on
Chrome for Android, it can be disabled by enterprise policy or by privacy configurations, and
its construction can fail at runtime when the worker script URL cannot be resolved — which is
a realistic outcome of an unusual bundler setup, a strict `script-src` CSP, or a library
consumer that copied the worker file to the wrong path.

Failing hard in that situation would mean the whole library stops working for a reason the
application developer cannot easily diagnose, even though ownership — the hard part — is
handled by Web Locks and needs no worker at all.

## Decision

The message bus is an interface (`Transport`) with two implementations:

1. `SharedWorkerTransport` — the default ([ADR-0006](./0006-sharedworker-as-message-broker.md)).
2. `BroadcastChannelTransport` - used when `SharedWorker` is unavailable or its construction
   throws. Every message goes to every context of the origin, and each receiver applies only
   the messages addressed to it: `all` for a configuration it has attached to, `owner` when it
   currently holds the ownership lock, and its own client id. No broker instance is needed,
   because the envelope already carries everything routing depends on.

This is possible only because ownership is decided by the Web Locks API and the write
lifecycle belongs to the context that issued the write (ADR-0005, ADR-0013). Neither depends
on a central authority, so the fallback is a change of delivery mechanism and nothing else.

Selection is automatic, reported at `warn` level, and can be forced with
`configure({ transport: 'sharedworker' | 'broadcastchannel' | 'auto' })` — the explicit
setting exists for testing and for applications that know their environment.

The fallback is **functionally equivalent**, which is the point of routing on an addressed
envelope rather than on broker-held state. The differences are confined to cost: every context
decodes every message, and a payload is cloned once per context rather than once per intended
recipient. At the message rates a serial port produces, neither is measurable.

## Alternatives considered

- **No fallback; throw `SHARED_WORKER_UNAVAILABLE`.** Honest and simple, and it was tempting.
  Rejected because the degradation is genuinely graceful: the only observable difference is
  presence latency, and an application that cannot open a port at all on Android is a worse
  outcome than one that opens it with slightly slower peer bookkeeping.
- **`BroadcastChannel` as the only transport.** Loses point-to-point routing and exact
  presence for everyone, to avoid maintaining two implementations. Rejected — the shared
  broker core keeps the duplication small.
- **Fallback to "every tab opens its own port".** Violates the entire premise; two tabs would
  fight over the device.

## Consequences

### Positive

- The library works wherever Web Serial works, not merely where both Web Serial and
  `SharedWorker` work.
- The `Transport` seam is also the seam the tests inject, so the fallback is not a
  second-class code path.

### Negative

- Two transports to maintain and to test. Mitigated by running the entire multi-context
  scenario matrix against **both** transports as a parameterised suite.
- With `BroadcastChannel`, a context sees traffic addressed to others and discards it. This is
  a privacy non-issue within one origin, but it does mean the fallback cannot be used to
  isolate untrusted same-origin frames from each other - and neither can the default.

## Verification

The multi-context suite is parameterised over both transports; a dedicated test asserts
automatic selection and the reported reason when `SharedWorker` construction throws.

## Amendment (2026-09-13): a worker script that fails to load

The decision above falls back when `SharedWorker` is missing or its construction throws. A script
URL that answers 404 does neither: the browser creates the worker and fires `error` on it
afterwards. By then the tab has said `hello`, attached its configurations and possibly claimed a
port, all into a port that delivers nothing. It stayed cut off from every other tab — reported as
`BROKER_UNAVAILABLE`, but not recovered.

### Decision

In `auto` mode the worker transport is wrapped in a `FallbackTransport`:

1. The broker answers every `hello` with a `welcome` addressed to the sender, which proves the
   script loaded and runs. Adding it changed the message shapes, so the protocol version went from
   2 to 3 (ADR-0008).
2. Until the welcome arrives, the wrapper records every message sent and every attach, detach and
   ownership change, in order.
3. If the worker reports an error first, nothing recorded reached anyone. The wrapper creates a
   `BroadcastChannelTransport`, replays the record into it — each message exactly once, in its
   original order — and uses it from then on. It logs `environment.transport-fallback` with
   `reason: 'worker-script-failed'`.
4. After the welcome the record is dropped, and a worker error is a transport error as before.
   `transport: 'sharedworker'` never falls back.

The record holds at most 1000 messages. A fetch that hangs while the tab streams data would
otherwise grow it without bound; beyond the limit, messages are counted and reported as dropped
rather than replayed. Attach, detach and ownership changes are always kept.

### Alternatives considered

- **Re-announce state instead of replaying.** Send `hello`, `attach` and `owner-claimed` again
  after switching. Smaller, but status broadcasts, traffic and write requests sent in between would
  be lost, and re-deriving them would reach into every configuration session.
- **Fall back when no welcome arrives within a timeout.** Needs no protocol change, but a slow
  network would switch tabs whose worker was merely late, splitting them from tabs whose worker
  arrived.

### Consequences

A mis-served worker script no longer cuts tabs off from each other. One partition remains: if the
script fails to load in one tab but loads in another — a transient network error rather than a
missing file — the two tabs are on different transports and do not hear each other. Ownership is
still decided by the Web Lock, so only one of them opens the device; the other waits for data and
write results that never arrive. Reloading that tab resolves it.

Verified by `test/unit/fallback-transport.test.ts` and
`test/integration/multi-tab/worker-script-fallback.test.ts`; manual test plan step 27.
