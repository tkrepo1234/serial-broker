# ADR-0007: Fall back to BroadcastChannel when SharedWorker is unavailable

- **Status:** Accepted
- **Date:** 2026-09-12

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

Selection is automatic, reported at `info` level, and can be forced with
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
