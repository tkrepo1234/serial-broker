# Internals

How serial-broker is built, for people changing it. Everything here is internal: none of it is
part of the public API, and any of it may change in a patch release. Why each part is built the way
it is, and what was rejected, is recorded in the repository's architecture decision records; the
[index of current decisions](https://github.com/tkrepo1234/serial-broker/blob/main/docs/adr/README.md)
is the one place that lists them. Their numbers are given in brackets.

## The platform constraint everything follows from

Web Serial exists only in windows, not in workers, so the port has to be held by a tab, and tabs
disappear without warning [ADR-0004]. Two tabs must never have the same device open. Everything
else is the consequence: an election that survives a tab dying, a bus between tabs, and a clear
answer to what happens to work in progress when the tab holding the port goes away.

```text
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
              ┌─────────┴──────────┐        ┌────────────────────────────┐
              │ SharedWorker       │        │ Web Locks (the browser)    │
              │  └ Broker (router) │        │  owner, term, tab-slot,    │
              └────────────────────┘        │  persisted, context, worker│
                                            └────────────────────────────┘
                   ● the physical SerialPort, held by exactly one tab
```

Two mechanisms, deliberately separate:

- **Web Locks decide.** Who holds the port, for which term, whether a tab or the worker is still
  there - every question whose wrong answer would corrupt device traffic is a lock the browser
  enforces and frees when a context dies.
- **The bus carries.** The broker routes messages and believes nothing it is told; a message is
  acted on only when a lock backs it.

## Layers

```text
facade        src/facade.ts               SerialBroker: a lazily created client behind named calls
entry points  src/index.ts, diagnostics.ts, global*.ts   what the package publishes (ADR-0043)
diagnostics   src/diagnostics.ts          openDiagnostics: an observer, independent of the facade
  │
client        src/client/                 one tab's view of every configuration
  ├ session   configuration-session.ts    one configuration: events, writes, role
  ├ writes    pending-writes.ts           the delivery guarantee for writes this tab issued
  ├ accepted  accepted-writes.ts          the holder's record of the writes it accepted
  ├ places    tab-slot.ts                 the tab limit: one Web Lock per place
  ├ terms     owner-terms.ts              the terms of holding the port: one Web Lock per term
  ├ observer  diagnostics-observer.ts     the read-only diagnostics participant
  └ transport transport/                  the message bus: SharedWorker or BroadcastChannel
  │
owner         src/owner/                  what a tab does while it holds the port
  ├ election  election.ts                 the Web Lock
  ├ supervisor port-supervisor.ts         open, read, write, reconnect
  ├ queue     write-queue.ts              one write to the device at a time
  ├ receive   receive-buffer.ts           received bytes, collected until the line is quiet
  ├ errors    serial-errors.ts            the browser's exceptions, mapped to error codes
  └ matcher   port-matcher.ts             which granted port is the configured device
  │
worker        src/worker/                 the broker, its ports, and the SharedWorker entry point
storage       src/storage/                remembered configurations and their shared lock
protocol      src/protocol/               message shapes, decoding, limits, lock names, handshake
core          src/core/                   errors, types, defaults, validation, backoff, time, events
environment   src/environment/            every browser API, injected
```

Imports run downward: the facade uses the client, the client uses owner, storage and protocol, and
everything uses core. `environment/` is the exception: client, owner and storage import its
interfaces, and its composition root, `browser.ts`, builds the client's transports. An import cycle
fails the lint.

No module outside the two composition roots - `src/environment/browser.ts` and the worker's entry
point, `src/worker/serial-broker.worker.ts` - reaches `navigator`, `window`, `localStorage` or the
timer functions; a lint rule enforces it, and time and randomness come from the environment too
[ADR-0014]. It is what lets the test suite run many simulated tabs in one process. Durations are
measured on the environment's monotonic clock, and only moments that are shown or sent on the wall
clock.

The environment describes each of those APIs in types of its own — `SerialLike`, `SerialPortLike`,
`LockManagerLike`, `KeyValueStorage` — naming no ambient Web Serial type, so that nothing
this package publishes needs `@types/w3c-web-serial`. `scripts/check-dist.mjs` type-checks every
emitted `.d.ts` without those types after each build [ADR-0014].

## Ownership

For each configuration, every tab that has set it up requests the Web Lock
`serial-broker/owner/v<protocol>/<name>` in exclusive mode [ADR-0005]. The tab granted the lock is
the owner for as long as it keeps the lock callback's promise pending; there is no other flag.
Inside that callback it takes the lock of a new **term** before it counts as the owner, then creates
a `PortSupervisor` and announces `owner-claimed` on the bus. When it stops, it closes the port
**before** releasing the lock, so the successor never finds the device still open; then it waits
until every write it performed has been answered, and sends `owner-released` as the last message of
its term.

With a tab limit, a tab requests the ownership lock - and joins the bus - only while it holds one
of `maxTabs` places, each the Web Lock `serial-broker/tab-slot/v<protocol>/<maxTabs>/<place>/<name>`.
Waiting tabs queue at a gate lock and, holding it, request every place at once; the first granted is
kept [ADR-0025].

When a tab dies, the browser releases its locks and grants the ownership lock to the longest-waiting
request. The successor's `owner-claimed` proves that the previous owner let go of the lock - but not
that its last messages have arrived, since they come from another sender. So every time of holding
the port is a term, a Web Lock of its own,
`serial-broker/term/v<protocol>/<maxTabs>/<term>/<clientId>/<name>`, held by the tab holding the
port from before its first word in the term until after its last [ADR-0030]. The name carries what a
tab must check before believing a message about the term: the term, the tab speaking for it, and
the tab limit that tab runs. Every other tab checks the lock with `ifAvailable` when it first hears
of a term and queues for it in `shared` mode, so:

- a claim or a status is believed only while that lock is held - a message cannot invent a term, or
  a tab limit for it;
- a term ends exactly when the browser frees the lock, which it does as it tears a crashed tab
  down - no grace period, no timer;
- a tab letting go cleanly queues a second request of its own on the term's lock before it says
  goodbye, and the tabs watching the term - which look the moment the lock is free, where a crash
  leaves nothing queued - see that request and wait for the `owner-released` the term still owes
  them. A message alone therefore never ends a term.

`OwnerTerms.authorize()` is the one table of who may say what: claims and statuses once their term's
lock is held, a write's progress and result from the context speaking for its term, device data and
errors from a context speaking for a term the tab knows of.

## The message bus

The bus is an interface, `Transport`, with two implementations [ADR-0006]:

- **`SharedWorkerTransport`** connects to a `SharedWorker` running the `Broker`. The broker tracks
  which tabs participate in which configuration, from each tab's `hello`, which names every
  configuration the tab takes part in and is sent again whenever that changes. It routes each
  message to `all` participants of a configuration or to one tab. It knows no owner: a write request
  goes to every participant, and only the tab holding the addressed term acts on it. A port tells
  nobody when the context at its other end goes away, so liveness is Web Locks [ADR-0041]: every tab
  holds `serial-broker/context/v<protocol>/<clientId>` for its lifetime, and the worker forgets the
  tab when the browser grants it that lock; the worker holds `serial-broker/worker/v<protocol>/<id>`
  for its lifetime, named in its `welcome`, and a tab granted that lock reports
  `BROKER_UNAVAILABLE`, starts a new worker, and restores its part there with a `hello`.
- **`BroadcastChannelTransport`** sends every message to every tab; each tab keeps a message only
  if it is addressed to a configuration it participates in, or to its own identifier.

Because routing depends only on the addressed envelope, and ownership only on Web Locks, the two
behave identically. Messages meant only for a broker, or written by one - `hello`, `welcome`,
`worker-log` - reach nobody above either transport.

Every script of the origin can reach the bus as well, so the worker trusts a port with no more than
it said about itself (`WorkerPorts`). A port's first message must be `hello`, and names the identity
the port speaks as from then on; a message before it, or in another sender's name, is dropped. An
identity may have several ports - a tab that gave up on a worker that did not welcome it in time may
reach it again on a new one - and each of them receives what is addressed to the identity, until the
identity's lock is let go. Nothing the worker routes depends on believing an identity. The test
harness routes through the same class. `SECURITY.md` lists what this does and does not protect.

The worker can reach no logger: it is a context of its own, and the logger an application configured
belongs to a tab. It therefore sends its `warn` and `error` records to the contexts connected to it,
as `worker-log` messages, and each tab writes them to its own logger under the worker's own events -
`worker.message-refused`, `worker.limit-exceeded`, `broker.limit-exceeded` and the rest. The worker
writes each kind of warning once, so what it forwards is bounded without a budget [ADR-0018].

In the default mode the worker transport is wrapped in a `FallbackTransport`. A `SharedWorker`
whose script answers 404 is still created; the browser reports the failure afterwards. So until
the broker's `welcome` arrives, the wrapper can still move. If the failure comes first, none of what
the tab sent reached anyone: the tab carries on over a `BroadcastChannel`, attached to what it takes
part in, and restates its status or asks for it, as after reaching a new worker. Nothing is
replayed. A worker that has not welcomed the tab 45 seconds after it was started is treated the same
way [ADR-0006].

The same happens when the worker script is of another protocol version, such as a copied worker
file left over from an earlier release. The `hello` and the `welcome` are the one exchange whose
shape no version may change: a worker answers every `hello`, whatever its version, with a `welcome`
in its own. A tab that receives a message in another version on the worker's port reports
`PROTOCOL_VERSION_MISMATCH` and falls back as above. Where nothing falls back — with
`transport: 'sharedworker'`, or on a worker started in place of one that ended — the tab closes its
port and starts no other worker, since one started from the same URL runs the same script; only a
reload helps [ADR-0008].

## The protocol between tabs

Every message carries `{ v, from, to, type }` and is validated completely on arrival; anything
malformed is dropped [ADR-0008]. `decodeMessage` is total: whatever it is handed, it returns a
message or a reason, and never throws. Every field is also held to a limit - identifiers, names,
payloads, text, name lists, errors and reports, in `src/protocol/limits.ts` - and an accepted
message is rebuilt from the fields its type declares, so nothing a sender adds is passed on. A
message beyond a limit is dropped and logged once per limit, not once per message. The broker bounds
what it keeps in the same way: participants, ports per participant, and configurations.

| Message                                     | Sent by                 | Purpose                                                                     |
| ------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `hello`                                     | every tab on the worker | Announces a tab and every configuration it takes part in; sent on change.   |
| `welcome`                                   | the broker              | Answers `hello`: the script runs; names the lock the worker holds.          |
| `worker-log`                                | the broker              | One of the worker's own records, for the tab's logger [ADR-0018].           |
| `owner-claimed`, `owner-released`           | the owner               | A term of holding the port began; it ended, as its last message.            |
| `status-request`                            | a tab that just set up  | Asks the owner to restate the status, or to retry where it gave up.         |
| `status`                                    | the owner               | The connection status changed, with the owner's tab limit, device and term. |
| `write-request`                             | a participant           | Asks the owner in one term to write.                                        |
| `write-ready`, `write-result`               | the owner               | Asks the issuer whether the write may begin, in a term; how it ended.       |
| `write-approval`                            | the issuing tab         | Answers `write-ready`: the write may begin, or it was given up.             |
| `data-received`, `data-sent`                | the owner               | Traffic, to every participant.                                              |
| `error`                                     | the owner               | A failure every participant should know about.                              |
| `diagnostics-request`, `diagnostics-report` | an observer; every tab  | The diagnostics collection [ADR-0018].                                      |

The protocol version is part of every message, of the lock names, and of the name of the worker and
the channel, and it is incremented on any change to a message. Tabs on different versions therefore
never exchange messages or contend for the same lock, and both will try to open the device. So that
they can still detect each other, every tab also announces its protocol version on
`serial-broker/announcements`, a channel whose name and single message never change [ADR-0008].
Remembered configurations carry a storage version of their own, so they survive a protocol change,
and each lives under a key of its own, listed in an index, so that two tabs saving at the same
moment cannot overwrite each other's [ADR-0033].

## The connection

`PortSupervisor` is a state machine [ADR-0010]:

```text
idle ──▶ listing ──▶ opening ──▶ open ──▶ reconnecting ──▶ listing ─ …
            │                                  │
            └▶ awaiting-permission             └▶ failed (after maxAttempts, at once for a
                                                   non-retryable error, or on the first loss
                                                   with autoReconnect: false)
                                                  stopped (when the tab stops being the owner)
```

Every way to lose a connection — a failed or timed-out `open()`, a read that fails or ends, a write
that fails, a `disconnect` event — goes through one handler, which reports the error, closes what is
open, and schedules the next attempt with exponential backoff and jitter. `open()`, `close()`,
`read()`, `write()`, and even `reader.cancel()` and `writer.abort()` can stay pending forever against
a device that has stopped answering, so every one of them is bounded by a deadline; a timeout is a
normal, reported outcome. A generation counter makes a late result from an abandoned attempt
harmless.

Writes at the port go through a queue, so the bytes of one write are never interleaved with
another's. A chunk the device has not taken within `writeTimeoutMs` fails its caller but stays in
flight, and the connection is kept: the browser cannot withdraw it, and closing the port would never
complete [ADR-0013].

Received bytes are collected until the line has been quiet for `receive.idleMs`, and delivered to
every tab as one event [ADR-0002].

What an application sees is the status, not the supervisor's state: `idle`, `queued` (only with a
tab limit), `awaiting-permission`, `connecting`, `open`, `reconnecting`, `failed`, and `released`
once the configuration is released in this tab. A tab that does not hold the port shows the status
the tab holding it reports, and `reconnecting` while ownership moves.

## Writes across tabs

A write belongs to the tab that issued it, not to the owner or the broker [ADR-0013].
`PendingWrites` in that tab holds it until a term exists, addresses it to that term, and settles it
when the term reports the result. Because this decision lives in the issuing tab, it is the same on
both transports and does not depend on the broker. The owner records the writes it accepted in its
term (`AcceptedWrites`), so a request handed to it twice is answered, not written twice.

**The issuing tab decides whether a write begins** [ADR-0013]. Its `writeTimeoutMs` decides when a
write that has not begun is given up, and no clock of another tab can tell when that is. So when a
write from another tab is next in its queue, the owner sends `write-ready` to the issuing tab and
waits. That tab answers `write-approval`: yes while it still waits on the write - and in the same
turn it counts the write as begun, not repeatable, `started: true` at its deadline - and no once it
has given the write up. The owner begins only on a yes from that tab, and waits no longer than its
own `writeTimeoutMs`; an owner's own writes are decided the same way, without a message.

```text
issuing tab ──write-request──▶ every tab; the owner of the addressed term queues it
            ◀─write-ready───── the owner, when the write is next
            ──write-approval─▶ the owner: approved, or given up
            ◀─write-result──── the owner, when the write has ended
```

A new claim does not decide anything by itself: the former term's result may still be on its way. A
term ends when the browser frees its lock, or - for a holder that is letting go cleanly - at its
`owner-released` [ADR-0030]. Only then is a write that term began and did not answer rejected with
`OWNER_LOST_DURING_WRITE`, and a write addressed to it that it never began handed to the owner now:

| When the term holding the port ends | Outcome                                                      |
| ----------------------------------- | ------------------------------------------------------------ |
| The write had not begun             | Handed to the next term. Written once.                       |
| The write had been let begin        | Rejected with `OWNER_LOST_DURING_WRITE`. **Never repeated.** |

An owner that crashed can have begun only what the issuing tab let it begin, so a crash never makes
a begun write look unstarted.

What the bus can cost a tab is bounded as well as validated [ADR-0031]: a port keeps a bounded
number of waiting writes and payload bytes, and refuses the rest with `WRITE_QUEUE_FULL`; answers to
status and diagnostics requests are rate-limited, a diagnostics collection keeps a bounded number of
reports, and what a flood would repeat in the log is logged once per kind.

## Errors

There is one error class, `SerialBrokerError`, with a stable code, structured context and a
remediation sentence for every code [ADR-0012]. Errors that cross the bus are serialised and rebuilt
in the receiving tab; the original cause comes back as a plain `Error` with its name and message.
Browser exceptions are mapped to codes through an explicit table keyed on the `DOMException` name,
never on message text.

## Diagnostics

The application-facing API hides all of the above [ADR-0011]. An operator can see it through
`serial-broker/diagnostics`, which opens a **diagnostics observer**: a context on the bus with no
configuration and no place in any election, so observing never moves a port [ADR-0018].

```text
observer ──diagnostics-request──▶ every context on the bus
         ◀─diagnostics-report──── each context with a configuration: role, status, settings,
                                   listeners, pending writes; the owner adds its connection
observer ──LockManager.query()──▶ the browser: who holds and who waits for each lock it uses
```

A collection listens for a fixed window, because nothing says how many contexts exist, and a report
is filed by its sender and configurations rather than validated field by field: it is only ever
displayed.

## What lives where, and why it is not somewhere else

| Decision                               | Where it lives                                | Why not elsewhere                                                                                   |
| -------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Who holds the port, and for which term | The browser's lock manager                    | Anything we implement can split-brain, or be forged by a message; a lock cannot.                    |
| Whether a tab or the worker is there   | The browser's lock manager                    | A port reports nothing when its other end dies, and a timeout misjudges every throttled tab.        |
| What happens to an in-flight write     | The context that issued it                    | It is the only one that knows what it asked for, and it works identically with or without a broker. |
| Message routing                        | The broker, or each tab on `BroadcastChannel` | Routing depends only on the envelope, so it needs no state worth losing and believes no claim.      |
| Reconnect policy                       | The owner's supervisor                        | It is the only context that can act on it.                                                          |
| Validation of anything external        | The boundary module for that source           | Once, at the edge; everything inside may then trust its inputs.                                     |

## Testing

The test suite runs in Node with no browser at all. `test/harness/` provides simulated
implementations of everything in the environment, faithful to the specifications:

- a lock manager with exclusive and shared locks, FIFO queueing, `ifAvailable`, `AbortSignal`, and
  release when a tab or a worker is killed;
- a serial registry whose devices can be plugged, unplugged, made to fail or hang on open and
  write, and made to emit data;
- a bus with both transports, the real broker and worker ports, asynchronous delivery and structured
  cloning;
- a fake clock with a wall and a monotonic reading, so backoff delays are asserted exactly.

A test opens several simulated tabs, closes or kills them at chosen moments, and asserts what each
tab observed. Every scenario that involves coordination runs against both transports. The harness
has tests of its own, because a simulation that is wrong in the same way as the code would make
every test pass for the wrong reason.

A second suite, `test/browser/`, runs the **built** package in a real Chromium: several pages of one
origin sharing a port through a real `SharedWorker`, failover when the page holding it is closed or
killed, the `BroadcastChannel` fallback, and the minified entry point. It answers what the
simulation cannot — that the platform behaves as the harness claims, and that the published files
load and find each other — and a part of it runs against a real serial device, or an emulated USB
device attached over USB/IP, when one is attached [ADR-0035].

What neither suite can prove is recorded in `docs/manual-test-plan.md`, which is worked through in a
real browser, with real or emulated hardware, and where every hardware run is recorded.

What the library costs is measured rather than tested: `bench/` runs the same scenarios - chunks
from the device to ten tabs, writes from a tab, handovers, starts, an hour of traffic - on the
harness and in a real browser, against expectations written down before anything is measured,
and the [Performance](performance.md) chapter records the results [ADR-0037].
