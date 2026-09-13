# Architecture

How the library works. For _why_ each choice was made, and what was rejected, see
[the ADRs](./adr/).

## The problem in one paragraph

The Web Serial API grants one browsing context exclusive access to a device. A second
`open()` fails. The API is also exposed only on `Navigator` — it does not exist in workers —
and `requestPort()` requires a user gesture. So the port must live in a window; windows
disappear without warning; and the thing that must never happen is two windows writing to one
device at the same time.

## The shape of the solution

```
┌─ tab A ─────────────────┐  ┌─ tab B ─────────────────┐  ┌─ tab C ─────────────────┐
│ SerialBroker (facade)   │  │ SerialBroker            │  │ SerialBroker            │
│ SerialBrokerClient      │  │ SerialBrokerClient      │  │ SerialBrokerClient      │
│  └ ConfigurationSession │  │  └ ConfigurationSession │  │  └ ConfigurationSession │
│      ├ OwnershipElection│  │      ├ OwnershipElection│  │      ├ OwnershipElection│
│      └ PortSupervisor ● │  │        (queued)         │  │        (queued)         │
└──────────┬──────────────┘  └──────────┬──────────────┘  └──────────┬──────────────┘
           │                            │                            │
           └────────────┬───────────────┴────────────────────────────┘
                        │  MessagePort
              ┌─────────┴──────────┐        ┌──────────────────────────┐
              │ SharedWorker       │        │ Web Locks (the browser)  │
              │  └ Broker (router) │        │  serial-broker/owner/... │
              └────────────────────┘        └──────────────────────────┘
                        │
                   ● the physical SerialPort, held by exactly one window
```

Two mechanisms, deliberately separate:

- **The Web Lock decides who owns the port.** Not the worker, not a vote, not a heartbeat.
- **The worker routes messages.** It has no say in ownership and holds nothing worth losing.

Keeping those apart is what makes the design comprehensible. The lock is a correctness
mechanism the browser enforces; the worker is a performance and convenience mechanism whose
failure degrades nothing but efficiency.

## Layers

```
public facade        src/serial-broker.ts      the zero-argument singleton
  │
client               src/client/               one context's view of every configuration
  ├ session          configuration-session.ts  one configuration: events, writes, role
  └ transport        transport/                the message bus, two implementations
  │
owner                src/owner/                what a context does while it holds the port
  ├ election         election.ts               the Web Lock
  ├ supervisor       port-supervisor.ts        open, read, write, reconnect
  └ matcher          port-matcher.ts           which granted port is the configured device
  │
worker               src/worker/               the broker, and its SharedWorker entry point
storage              src/storage/              configuration persistence
protocol             src/protocol/             the wire format and its validator
core                 src/core/                 errors, types, time, bytes, events
environment          src/environment/          the platform, injected
```

Imports run strictly downward. `core/` imports from nothing above it, and a cycle is a build
failure.

## The five things worth understanding

### 1. Ownership is a lock, not an agreement

Every context with a configuration set up keeps a request outstanding for the Web Lock
`serial-broker/owner/v<protocol version>/<name>`. Whoever is granted it is the owner and holds it by keeping
its callback's promise pending.

When the owning context dies — closed, crashed, out of memory, laptop lid — **the browser
releases the lock** as part of tearing the context down, and the longest-waiting context is
granted it. There is no timeout to tune and no cooperation required from the departing tab.
This is the single most important property of the design; see
[ADR-0005](./adr/0005-owner-election-via-web-locks.md).

The new owner announces itself with `owner-claimed`. That message doubles as the death notice
for the previous owner: the lock cannot be granted while it is held, so a new owner existing
is proof that the old one is not writing.

### 2. A write belongs to the context that issued it

Not to the broker. The issuing context holds the request, marks it non-replayable when the
owner reports it has begun writing, and resolves it when a result arrives — or when a _new_
owner announces itself, which means the previous one is gone.

That placement is what makes the two transports behave identically and what makes the
guarantee testable:

| When the owner dies        | Outcome                                                     |
| -------------------------- | ----------------------------------------------------------- |
| The write never reached it | Re-sent to the new owner. Delivered exactly once.           |
| The write had begun        | Rejected with `OWNER_LOST_DURING_WRITE`. **Never retried.** |

See [ADR-0013](./adr/0013-write-ordering-and-delivery-semantics.md).

### 3. Every message is addressed, and every message is validated

The envelope carries `{ v, from, to }`, where `to` is `'all'`, `'owner'`, or a specific
context. The broker resolves those three targets; with the fallback transport each context
resolves them for itself. Nothing else differs between the two.

`'owner'` is resolved at _delivery_ time, never by the sender — ownership can move between a
context deciding to write and the message being routed.

Anything arriving from another context is `unknown` until it has passed `decodeMessage`,
which is total: it returns a reason, never throws, whatever it is handed.

### 4. Every external call is bounded

`open()`, `close()`, `read()`, `write()`, and even `reader.cancel()` and `writer.abort()` can
stay pending forever against a device that has stopped answering — the last two because they
wait for the stream's in-flight operation. Every one of them is wrapped in a deadline. A
timeout is a normal, reported outcome, not an exception to the design.

### 5. The platform is injected

No module outside `src/environment/` touches `navigator`, `window`, `Date`, `Math.random` or
`setTimeout`; a lint rule enforces it and the test environment has no browser globals at all.
That is what lets one test process run a dozen independent tabs, kill any of them at a chosen
instruction boundary, and assert a backoff schedule exactly. See
[ADR-0014](./adr/0014-dependency-injection-of-the-environment.md).

## Connection lifecycle

```
        setup()
           │
           ▼
  ┌──────────────────┐  no granted port matches   ┌──────────────────────┐
  │   (not owner)    │ ─────────────────────────▶ │ awaiting-permission  │
  │  waits for lock  │                            └──────────┬───────────┘
  └────────┬─────────┘                              requestAccess() from a gesture
     lock granted                                              │
           ▼                                                   ▼
     ┌───────────┐   open() ok    ┌──────┐   loss    ┌──────────────┐
     │ connecting│ ─────────────▶ │ open │ ────────▶ │ reconnecting │
     └───────────┘                └──────┘           └──────┬───────┘
           ▲                                                │ backoff, or
           └────────────────────────────────────────────────┘ `connect` event
                                                            │ maxAttempts
                                                            ▼
                                                        ┌────────┐
                                                        │ failed │ ── device reappears ─┐
                                                        └────────┘                      │
                                                             ▲───────────────────────────┘
```

Every way a connection can be lost — a failed open, a failed write, a dead read stream, a
`disconnect` event — funnels into one handler, so there is exactly one backoff policy and one
place to test it. See [ADR-0010](./adr/0010-reconnect-supervision-and-backoff.md).

## Diagnostics

The application-facing API hides all of the above (ADR-0011). An operator can see it through
`serial-broker/diagnostics`, which opens a **diagnostics observer**: a context on the bus with no
configuration and no place in any election, so observing never moves a port.

```
observer ──diagnostics-request──▶ every context on the bus (the broker delivers to all)
         ◀─diagnostics-report──── each context with a configuration: role, status, settings,
                                   listeners, pending writes; the owner adds its connection
observer ──LockManager.query()──▶ the browser: who holds and who waits for each owner lock
```

A collection listens for a fixed window, because nothing says how many contexts exist. See
[ADR-0018](./adr/0018-diagnostics-observer.md).

## What lives where, and why it is not somewhere else

| Decision                           | Where it lives                      | Why not elsewhere                                                                                   |
| ---------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| Who owns the port                  | The browser's lock manager          | Anything we implement can split-brain; this cannot.                                                 |
| What happens to an in-flight write | The context that issued it          | It is the only one that knows what it asked for, and it works identically with or without a broker. |
| Message routing                    | The broker                          | One authoritative point makes ordering and de-duplication trivial.                                  |
| Reconnect policy                   | The owner's supervisor              | It is the only context that can act on it.                                                          |
| Validation of anything external    | The boundary module for that source | Once, at the edge; everything inside may then trust its inputs.                                     |
