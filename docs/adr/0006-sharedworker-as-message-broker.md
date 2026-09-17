# ADR-0006: A SharedWorker broker routing to all participants, with a BroadcastChannel fallback

- **Status:** Accepted

## Context

Every participant must see every received chunk, every write performed by any participant, and
every status change, in the same order. Writes from tabs that do not hold the port must reach the
tab that does, and their outcome must come back to their originator. Ownership is already solved by
Web Locks ([ADR-0005](./0005-owner-election-via-web-locks.md)); what remains is a bus.

`SharedWorker` is not universally available even where Web Serial is. It can be disabled by
enterprise policy, a sandboxed frame can be without it, and a worker whose script URL cannot be resolved -
because of an unusual bundler setup, a strict `script-src`, or a worker file copied to the wrong
path - is still created: the browser reports the failure afterwards, as an `error` event.

Every script of the origin can reach the bus as well, under any identity it writes into a message
(`SECURITY.md`). Integrity cannot rest on who a message says it is from.

## Decision

The bus is an interface, `Transport`, with two implementations. Selection is automatic and can be
forced with `configure({ transport: 'sharedworker' | 'broadcastchannel' | 'auto' })`.

**`SharedWorkerTransport`, the default.** A `SharedWorker` runs the **broker**: one long-lived
context holding a `MessagePort` to every participant. Its job is deliberately narrow:

1. Track which contexts take part in which configuration. A tab's `hello` names every configuration
   it takes part in and is sent again whenever that changes; the broker takes each for the whole of
   the tab's participation.
2. Resolve two delivery targets: `all` participants of a configuration except the sender, and one
   participant.

It does **not** touch the port, decide or even know who owns it, hold or replay writes, interpret
payloads, or persist anything. What is meant for the tab holding the port - a `write-request`, a
`status-request` - is addressed to `all`, and only the tab holding the term it names acts on it
([ADR-0018](./0018-hold-a-web-lock-for-every-term-of-holding-the-port.md)). A claim of ownership
the broker believed would be one any script could forge.

The worker keeps each port to one identity, which is cheap and keeps one port from speaking for
many contexts (`WorkerPorts`): a port's first message must be `hello` and names the identity it
speaks as; a message before it, one in another sender's name, or a `hello` as the broker itself is
dropped. An identity may have several ports, and each receives what is addressed to it. Participants
and ports per participant are bounded (`MAX_PARTICIPANTS`, `MAX_PORTS_PER_PARTICIPANT`). How the
worker learns that a tab has gone, and a tab that the worker has, is
[ADR-0024](./0024-tell-liveness-through-web-locks.md).

The worker script is resolved via `new URL('./serial-broker.worker.js', import.meta.url)` and can be
overridden with `configure({ workerUrl })`.

**`BroadcastChannelTransport`, the fallback.** Every message goes to every context of the origin, and
each receiver applies only what is addressed to it: `all` for a configuration it takes part in, and
its own identity. Messages meant for or written by a broker (`hello`, `welcome`, `worker-log`) are
dropped. No broker instance is needed, because the envelope carries everything routing depends on.

**Falling back.** In `auto` mode the worker transport is wrapped in a `FallbackTransport`. Until the
broker's `welcome` proves the script runs, it moves to `BroadcastChannel` when:

- the worker reports an error (`worker-script-failed`),
- a message in another protocol version arrives on the worker's port
  (`worker-other-protocol-version`, [ADR-0007](./0007-wire-protocol-and-versioning.md)), or
- no `welcome` has arrived within the handshake deadline of 45 seconds (`worker-not-answering`).

Nothing the tab sent before that reached anyone, and nothing is sent again. The new bus is told what
the tab takes part in, and the client restates itself as after reaching a new worker: the tab holding
the port its status, every other tab a request for it. Write requests are handed on once the holder
restates `open`, and the holder recognises a request it has already accepted
([ADR-0011](./0011-write-ordering-and-delivery-semantics.md)). The switch is logged as
`environment.transport-fallback` with the reason. After the `welcome` nothing moves.
`transport: 'sharedworker'` never falls back; on a worker of another protocol version it stops using
workers until the page is reloaded (ADR-0007).

The write lifecycle lives in the context that **issued** the write, not in the broker (ADR-0011).
Together with ownership by Web Lock, that is what makes the fallback a change of delivery mechanism
and nothing else.

## Alternatives considered

- **`BroadcastChannel` only, no worker.** Simpler, and not strictly less correct. Rejected as the
  default because a broadcast bus puts every message in front of every tab of the origin, clones
  each payload once per tab, and makes a tab that merely listens pay to decode traffic for other
  configurations. It remains the fallback.
- **`localStorage` events as the bus.** Serialises everything through strings, fires only in
  _other_ tabs, has no ordering guarantee, and is a well-known source of subtle bugs.
- **A broker that routes to the owner**: it keeps the tab that last sent `owner-claimed` and
  delivers what is meant for the owner to it alone. The broker cannot ask the Web Lock, so it would
  believe the claim, and any script of the origin could claim a configuration and receive every
  other tab's writes, which would then time out. Having the worker check
  the term's lock would cost it an asynchronous lock request per claim, and `BroadcastChannel`
  would still deliver to all.
- **Bind each identity on the worker to a secret sent in `hello`.** It keeps a script from
  connecting as a tab whose identity it heard, but not from claiming the port under its own
  identity; it holds on the `SharedWorker` only; and it costs a secret source, a binding table with
  its own bound and two refusal reasons. A script of the origin can call the library itself, so an
  identity on the bus is not what integrity rests on.
- **A worker that elects the owner by observing port disconnects.** Presence is not mutual
  exclusion (ADR-0005).
- **No fallback; fail where the worker is missing.** Honest and simple, but an application that
  cannot open a port at all where the worker is missing is a worse outcome than one on a slower bus.
- **Fall back to "every tab opens its own port".** Violates the entire premise.
- **Replay what was sent before the `welcome` into the fallback**, bounded at 1000 messages.
  Restating what the other tabs need to know is smaller and needs no record; what is lost is traffic
  sent in the moments before the switch.
- **Fall back only on a timeout.** A slow network would switch tabs whose worker was merely late,
  splitting them from tabs whose worker arrived.

## Consequences

### Positive

- The library works wherever Web Serial works. The `Transport` seam is also the seam the tests
  inject, so the fallback is not a second-class code path.
- Nothing the broker does depends on believing a message: a forged `owner-claimed` diverts no write
  and delays none.
- The broker holds no state that has to be recovered: a new worker learns everything from each
  tab's `hello`.

### Negative

- Every participant receives, and structurally clones, each write request of its configuration.
  Write requests are small next to the traffic every participant receives anyway.
- A script of the origin can say `hello` under a tab's identity and receive what is addressed to that
  tab alone - a write's progress and result, which it could read on the configuration's traffic in
  any case. It cannot take the tab's messages away: ports of one identity are served side by side.
- A `SharedWorker` needs a script URL, so a `Blob` URL cannot be used: each tab would produce a
  different URL and so a different, unshared worker.
- Two transports to maintain and test. Mitigated by running the multi-context scenario matrix
  against both.
- One partition remains: a script that fails to load in one tab but loads in another - a transient
  network error rather than a missing file - leaves the two tabs on different buses. Ownership is
  still the Web Lock, so only one opens the device; reloading the other tab resolves it.

## Verification

`test/unit/broker.test.ts`, `test/unit/worker-ports.test.ts`, `test/unit/transports.test.ts` and
`test/unit/fallback-transport.test.ts`; `test/integration/multi-tab/shared-worker.test.ts` (a worker
script that fails to load, or is of another protocol version) and `test/integration/multi-tab/hostile-bus.test.ts` (a forged claim diverts no write; a `hello` in a
tab's name leaves it connected); the multi-context suite is parameterised over both transports, and
`test/browser/transports.spec.ts` runs the fallback in a real browser.
