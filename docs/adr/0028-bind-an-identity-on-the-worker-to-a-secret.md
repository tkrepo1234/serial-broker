# ADR-0028: Bind an identity on the worker to a secret sent in `hello`

- **Status:** Accepted
- **Date:** 2026-09-14
- **Amends:** ADR-0006

## Context

The worker holds every port to the identity its first message, `hello`, named (ADR-0024,
`WorkerPorts`). That stops one port from speaking for many contexts, but not the other direction: a
tab's identity is no secret. It is in every message the tab sends, on a `BroadcastChannel` every
script of the origin can open, and in every diagnostics report. Any script of the origin could
therefore start the same worker, say `hello` under a tab's identity, and be served next to that tab.

The worker cannot refuse such a port by what it knows: a tab that gave up on a worker that hung
connects again on a new port under the same identity (ADR-0021), and nothing in the message
distinguishes the two. So `SECURITY.md` had to list, among the things a same-origin script can do,
that it receives a copy of everything addressed to a tab alone on the worker - including the write
requests sent to the tab holding the port.

That is inherent on `BroadcastChannel`, where every context receives every message anyway. It is not
inherent on the worker, which sees each port separately and could tell the two cases apart if the
tab had something to show that the other script has never seen.

## Decision

Every transport that uses a worker generates a random secret at construction, from the platform's
cryptographic random source through the injected environment (`newSecret`, ADR-0014), and sends it
in its `hello` and in no other message. The worker binds an identity to the first secret it is shown
and refuses a later `hello` naming that identity with another one, or with none. A refusal is logged
once per reason, as every refusal is.

- **A tab connecting again is served.** The transport keeps its secret for its lifetime, so the
  `hello` to a worker started in place of one that hung carries the same secret as the first.
- **`BroadcastChannel` sends no secret.** Every context of the origin receives what is posted there,
  so a secret would be none. Its `hello` carries no `secret` field, and the worker refuses such a
  `hello` on a port. No protection of this kind is possible on that transport, and `SECURITY.md`
  says so.
- **Bindings outlive participants, and are bounded.** A tab forgotten for its silence (ADR-0021)
  must still be the only one that can come back as itself, so a binding is kept after the identity
  leaves the broker. A binding is let go of when the identity says goodbye - a context's identity is
  generated once, so it never returns - and, past `MAX_BOUND_IDENTITIES`, the oldest binding of an
  identity with no port left is forgotten, and that identity can be claimed again.

The field is added compatibly with the frozen handshake (ADR-0024): only `type`, the sender identity
and `v` are frozen there, and a worker of another version reads neither. A version 7 tab reaching a
version 8 worker, or the reverse, is answered exactly as before - with a `welcome` in the worker's
own version - and takes no part.

## Alternatives considered

- **Leave it as documented.** It is the honest description of a bus that carries no sender identity,
  but on the worker the port itself is an identity the browser guarantees, and using it costs one
  field.
- **Keep the binding per port only, and decide by which port is older.** A script that says `hello`
  first would own the identity, so the protection would depend on a race with the tab it imitates.
- **Derive the secret from the identity** - a hash, or an identity long enough to be unguessable.
  Then the secret travels in every message, and any script that heard one message has it.
- **Give the worker a nonce** the tab has to echo. It needs an exchange before the tab may speak,
  which the frozen handshake (ADR-0024) has no room for, and it would have to survive the worker
  being replaced.
- **Refuse further `hello`s for a registered identity outright.** It would cut off exactly the tab
  that gave up on a hung worker, which ADR-0021 exists to keep working.

## Consequences

### Positive

- A same-origin script can no longer receive what is addressed to a tab alone on the worker, nor say
  anything in that tab's name there. It is still free to speak under an identity of its own, and on
  `BroadcastChannel` nothing changes.
- Two more refusal reasons, `secret-missing` and `secret-mismatch`, name the case in the worker's
  own records, which now reach the tabs (ADR-0029).

### Negative

- The protocol version is incremented, as any change to a message shape is (ADR-0008).
- One more thing the environment must provide. A context without `crypto.getRandomValues` cannot
  build a worker transport at all; with the default transport it falls back to `BroadcastChannel`,
  and with `transport: 'sharedworker'` it reports `BROKER_UNAVAILABLE`. Every context that has
  `navigator.serial` has `crypto`.

### Risks and mitigations

- **The bound is a way in.** A script that binds `MAX_BOUND_IDENTITIES` identities makes the worker
  forget the oldest bindings nothing holds. To take over a tab's identity that way it must also wait
  until the sweep has forgotten that tab - three minutes of complete silence, which a tab that is
  merely hidden never reaches - and until its binding is the oldest one left. The bound is four
  times the number of participants the broker keeps; without it, bindings would be the one thing on
  the worker that grows without limit.
- **The secret is only as good as the source.** It is 16 random bytes from `crypto.getRandomValues`,
  never derived from an identity, a time or a counter.
- **A secret must never be logged.** The worker's records name the identity a refused `hello`
  claimed, never the secret shown; the transport sends it in `hello` alone.

## Verification

`test/unit/worker-ports.test.ts` (a port that says `hello` as a tab with another secret hears
nothing addressed to it; a tab connecting again with its own secret is served, and so is one the
sweep had forgotten; an identity is free again once it said goodbye; the oldest binding of an
identity with no port is forgotten at the limit), `test/unit/transports.test.ts` (the secret is in
`hello` and in nothing else), `test/unit/worker-transport-liveness.test.ts` (a worker started in
place of one that hung is shown the same secret), and
`test/integration/multi-tab/hostile-bus.test.ts` (two tabs share the port while a script tries to
connect as one of them).
