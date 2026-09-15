# ADR-0040: Route to all participants; drop the identity secret

- **Status:** Accepted
- **Date:** 2026-09-15
- **Supersedes:** [ADR-0028](./0028-bind-an-identity-on-the-worker-to-a-secret.md)
- **Amends:** ADR-0006, ADR-0021, ADR-0029

## Context

The broker kept, for every configuration, the context that last sent `owner-claimed`, and delivered
every message addressed to `'owner'` - write requests with their payload, and status requests - to
that context alone (ADR-0006). The Web Lock decides who owns a port (ADR-0005), but the broker could
not ask the lock: it believed the claim. Any script of the origin could therefore connect to the
worker under an identity of its own, attach to a configuration and claim it. From then on every
write of every other tab went to that script, and ended in `WRITE_TIMEOUT`. The terms of holding the
port (ADR-0030) protect each tab from believing such a claim, but the routing happened before any tab
saw the message.

ADR-0028 bound identities on the worker to a secret sent in `hello`. That kept a script from
connecting as a tab whose identity it heard, but not from claiming the port under its own identity,
and it held on the `SharedWorker` only: the `BroadcastChannel` transport never had a secret, and on it
every context receives every message anyway. It cost a secret source in the environment, a binding
table with a bound of its own (`MAX_BOUND_IDENTITIES`), two refusal reasons, and a second rule for
what a reconnecting tab must show. And a script of the origin can call the library itself (the first
assumption of `SECURITY.md`), so an identity on the bus was never what integrity rested on.

## Decision

**The broker tracks no owner.** A message meant for the tab holding a configuration's port - a
`write-request`, a `status-request` - is addressed to `'all'` and delivered to every participant of
the configuration, exactly as the `BroadcastChannel` transport delivers it. Each message names the
term it is addressed to where that matters, and only the tab holding that term acts on it: a
`write-request` for another term is ignored, and only the tab holding the port answers a status
request. The `'owner'` target, the transports' ownership flag and `ownedConfigNames` in the heartbeat
exist only to route to an owner, and are removed.

**The identity secret is removed.** `hello` carries no secret, the worker binds no identity, and
`MAX_BOUND_IDENTITIES` and the environment's `newSecret` are gone. The worker still holds each port
to the identity its `hello` named and refuses a message in another sender's name: that check is
cheap, and keeps one port from speaking for many contexts.

Integrity rests where it already did: on the Web Locks of the terms (ADR-0030), checked by every tab
before it believes a claim, a status, a write's progress, device data or an error.

## Alternatives considered

- **Keep owner routing and have the broker check the term's lock.** A `SharedWorker` can use Web
  Locks, but the check is asynchronous, every claim would cost the worker a lock request, and the
  `BroadcastChannel` transport, which has no broker, would still need the delivery to all.
- **Keep the secret alongside routing to all.** It would protect nothing routing still depends on,
  and nothing on the `BroadcastChannel` transport.

## Consequences

- A forged `owner-claimed` diverts no write and delays none (`hostile-bus.test.ts`).
- Every participant receives, and structurally clones, each write request of its configuration, as
  on `BroadcastChannel` already. Write requests are small next to the traffic every participant
  receives anyway.
- A script of the origin can say `hello` under a tab's identity and receive what is addressed to that
  tab alone on the worker, as it already could on `BroadcastChannel`. What is addressed to one tab is
  a write's progress and result, which it could read on the configuration's traffic in any case. It
  cannot take the tab's messages away or end its participation: ports of one identity are served next
  to each other, and a `goodbye` ends only its own port.
- Protocol version 11.

## Verification

`test/unit/broker.test.ts` routes a write request to every participant after a forged claim.
`test/integration/multi-tab/hostile-bus.test.ts` claims the port from a script on the
`SharedWorker` and checks that another tab's write is written and resolves, and that a `goodbye` in a
tab's name leaves it connected. `test/unit/worker-ports.test.ts` covers what a port may say.
