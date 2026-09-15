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
│      └ PortSupervisor ● │  │   (waits for the lock)  │  │   (waits for the lock)  │
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
diagnostics          src/diagnostics.ts        the observer's entry point, for operators
  │
client               src/client/               one context's view of every configuration
  ├ session          configuration-session.ts  one configuration: events, writes, role
  ├ tab slot         tab-slot.ts               a place among the maxTabs tabs
  ├ pending writes   pending-writes.ts         the writes this context issued, until they settle
  ├ accepted writes  accepted-writes.ts        the owner's record, so a repeated write runs once
  ├ observer         diagnostics-observer.ts   the diagnostics observer
  └ transport        transport/                the message bus, two implementations
  │
owner                src/owner/                what a context does while it holds the port
  ├ election         election.ts               the Web Lock
  ├ supervisor       port-supervisor.ts        open, read, write, reconnect
  ├ write queue      write-queue.ts            one write to the device at a time
  ├ serial errors    serial-errors.ts          the browser's exceptions, mapped to error codes
  └ matcher          port-matcher.ts           which granted port is the configured device
  │
worker               src/worker/               the broker, and its SharedWorker entry point
storage              src/storage/              configuration persistence
protocol             src/protocol/             messages and their validator, the lock names, the
                                               worker handshake, the version announcement
core                 src/core/                 errors, types, validation, time, bytes, events
environment          src/environment/          the platform's interfaces, and the composition
                                               root that builds the real ones
```

Imports run downward: the facade uses the client, the client uses owner, storage and protocol,
and everything uses core. `environment/` is the exception: client, owner and storage import its
interfaces, and its composition root, `browser.ts`, builds the client's transports. `core/`
imports from nothing above it, and an import cycle fails the lint.

## The six things worth understanding

### 1. Ownership is a lock, not an agreement

Every context with a configuration set up keeps a request outstanding for the Web Lock
`serial-broker/owner/v<protocol version>/<name>`. Whoever is granted it is the owner and holds it by keeping
its callback's promise pending.

When the owning context dies — closed, crashed, out of memory, laptop lid — **the browser
releases the lock** as part of tearing the context down, and the longest-waiting context is
granted it. There is no timeout to tune and no cooperation required from the departing tab.
This is the single most important property of the design; see
[ADR-0005](./adr/0005-owner-election-via-web-locks.md).

The new owner announces itself with `owner-claimed`. The lock cannot be granted while it is held,
so a new owner existing is proof that the old one is not writing any more - but not that the old
one's last messages have arrived, since they come from another sender. So every time of holding
the port is a term with an identifier, named in the messages about ownership, writes and status
([ADR-0026](./adr/0026-attribute-messages-to-a-term-of-holding-the-port.md)).

A term is a Web Lock of its own, held for the whole term
([ADR-0030](./adr/0030-hold-a-web-lock-for-every-term-of-holding-the-port.md)). A tab believes a
claim or a status only while that lock is held, and takes the term for over when the browser frees
it - which it does as it tears a crashed tab down, so failover waits for no timeout. A tab that
lets go cleanly leaves a request of its own queued on the lock, and the other tabs wait for its
`owner-released`, the last message of the term. No message can end a term, or invent one.

### 2. A write belongs to the context that issued it

Not to the broker. The issuing context holds the request, marks it non-replayable when the
owner reports it has begun writing, and resolves it when a result arrives — or when the term of
the owner it was handed to has ended without one.

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

No module outside the two composition roots — `src/environment/browser.ts` and the worker's entry
point, `src/worker/serial-broker.worker.ts` — touches `navigator`, `window`, `localStorage` or the
timer functions; `no-restricted-globals` enforces it. By convention none reads `Date` or
`Math.random` either: time and randomness come from the environment too. The test environment
has no browser globals at all. That is what lets one test process run a dozen independent tabs,
kill any of them at a chosen instruction boundary, and assert a backoff schedule exactly. See
[ADR-0014](./adr/0014-dependency-injection-of-the-environment.md).

### 6. The worker is replaceable

A `MessagePort` reports nothing when the context at its other end dies, in either direction. So
every tab holds a Web Lock for its lifetime, which the worker waits on and is granted when the tab
has gone, and the worker holds one for its lifetime, which every tab waits on
([ADR-0041](./adr/0041-tell-liveness-through-web-locks.md)). A tab granted the worker's lock takes
the worker for dead — crashed, ended for memory, terminated from `chrome://inspect` — reports
`BROKER_UNAVAILABLE`, starts a new worker, and hands on what it had sent into the old one.

Every tab shows the worker a random secret in its `hello` and in no other message, so that no other
script of the origin can connect to the worker under that tab's identity; a tab that replaces its
worker shows the same secret
([ADR-0028](./adr/0028-bind-an-identity-on-the-worker-to-a-secret.md)). The worker can reach no
logger of its own, so it sends the records it writes at `warn` to the tabs, which log them as its
events ([ADR-0029](./adr/0029-forward-the-workers-records-to-the-tabs.md)).

A worker script that does not load, or that runs another protocol version, sends no welcome in
this version, and the tabs move to a `BroadcastChannel`
([ADR-0007](./adr/0007-broadcastchannel-fallback-transport.md),
[ADR-0024](./adr/0024-keep-the-worker-handshake-version-independent.md)). Tabs on different
protocol versions never share a lock, a worker or a bus; they learn of each other only through an
unversioned announcement channel ([ADR-0023](./adr/0023-announce-the-protocol-version.md)).

## Connection lifecycle

```
        setup()
           │
           ▼
       ┌──────┐  maxTabs other tabs use it   ┌────────┐
       │ idle │ ───────────────────────────▶ │ queued │
       └──┬───┘ ◀───── a place frees up ──── └────────┘
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

`released` follows from any state once the configuration is released in this tab, and nothing
follows it. `queued` exists only with a `maxTabs` limit
([ADR-0025](./adr/0025-limit-the-tabs-using-a-configuration.md)). A tab that does not hold the port
does not walk the lower part itself: it shows the status the tab holding the port reports, and
`reconnecting` while ownership moves.

Every way a connection can be lost — a failed open, a failed write, a dead or ended read stream,
a `disconnect` event — funnels into one handler, so there is exactly one backoff policy and one
place to test it. See [ADR-0010](./adr/0010-reconnect-supervision-and-backoff.md).

## Diagnostics

The application-facing API hides all of the above (ADR-0011). An operator can see it through
`serial-broker/diagnostics`, which opens a **diagnostics observer**: a context on the bus with no
configuration and no place in any election, so observing never moves a port.

```
observer ──diagnostics-request──▶ every context on the bus (the broker delivers to all)
         ◀─diagnostics-report──── each context with a configuration: role, status, settings,
                                   listeners, pending writes; the owner adds its connection
observer ──LockManager.query()──▶ the browser: who holds and who waits for each lock it uses
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
