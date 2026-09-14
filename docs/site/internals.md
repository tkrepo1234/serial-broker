# Internals

How serial-broker is built, for people changing it. Everything here is internal: none of it is
part of the public API, and any of it may change in a patch release. The reasons behind each part
are recorded as ADRs in the repository's `docs/adr/` directory; the numbers are given in brackets.

## The platform constraint everything follows from

Web Serial exists only in windows, not in workers, so the port has to be held by a tab, and tabs
disappear without warning [ADR-0004]. Two tabs must never have the same device open. Everything
else is the consequence: an election that survives a tab dying, a bus between tabs, and a clear
answer to what happens to work in progress when the tab holding the port goes away.

## Layers

```text
facade        src/serial-broker.ts        SerialBroker: a lazily created client behind named calls
diagnostics   src/diagnostics.ts          openDiagnostics: an observer, independent of the facade
  │
client        src/client/                 one tab's view of every configuration
  ├ session   configuration-session.ts    one configuration: events, writes, role
  ├ writes    pending-writes.ts           the delivery guarantee for writes this tab issued
  ├ accepted  accepted-writes.ts          the owner's record of the writes it accepted
  ├ places    tab-slot.ts                 the tab limit: one Web Lock per place
  ├ terms     owner-terms.ts              the terms of holding the port: one Web Lock per term
  ├ observer  diagnostics-observer.ts     the read-only diagnostics participant
  └ transport transport/                  the message bus: SharedWorker or BroadcastChannel
  │
owner         src/owner/                  what a tab does while it holds the port
  ├ election  election.ts                 the Web Lock
  ├ supervisor port-supervisor.ts         open, read, write, reconnect
  └ matcher   port-matcher.ts             which granted port is the configured device
  │
worker        src/worker/                 the broker and its SharedWorker entry point
storage       src/storage/                remembered configurations
protocol      src/protocol/               message shapes, validation, versioning
core          src/core/                   errors, types, defaults, validation, backoff, events
environment   src/environment/            every browser API, injected
```

An import cycle fails the lint. Library code reaches `navigator`, `window`, `localStorage` and the
timer functions only through the injected environment, and a lint rule enforces that too
[ADR-0014]. It is what lets the test suite run many simulated tabs in one process.

## Ownership

For each configuration, every tab that has set it up requests the Web Lock
`serial-broker/owner/v<protocol>/<name>` in exclusive mode [ADR-0005]. The tab granted the lock is
the owner for as long as it keeps the lock callback's promise pending; there is no other flag. When
it becomes the owner it creates a `PortSupervisor` and announces `owner-claimed` on the bus. When it
stops, it closes the port **before** releasing the lock, so the successor never finds the device
still open; then it waits until every write it performed has been answered, and sends
`owner-released` as the last message of its term.

With a tab limit, a tab requests the ownership lock - and joins the bus - only while it holds one
of `maxTabs` places, each the Web Lock `serial-broker/tab-slot/v<protocol>/<maxTabs>/<place>/<name>`.
Waiting tabs queue at a gate lock and, holding it, request every place at once; the first granted is
kept [ADR-0025].

When a tab dies, the browser releases its lock and grants it to the longest-waiting request. The
successor's `owner-claimed` proves to every other tab that the previous owner let go of the lock -
but not that the previous owner's last messages have arrived, which come from another sender. Each
time of holding the port is therefore a **term** with an identifier of its own, and messages about
ownership, writes and the status name their term [ADR-0026].

A term is a Web Lock as well, `serial-broker/term/v<protocol>/<maxTabs>/<term>/<clientId>/<name>`,
held by the tab holding the port from before its first word in the term until after its last
[ADR-0030]. The name carries what a tab must check before believing a message about the term: the
term, the tab speaking for it, and the tab limit that tab runs. Every other tab checks the lock with
`ifAvailable` when it first hears of a term and queues for it in `shared` mode, so:

- a claim or a status is believed only while that lock is held - a message cannot invent a term, or
  a tab limit for it;
- a term ends exactly when the browser frees the lock, which it does as it tears a crashed tab
  down - no grace period, no timer;
- a tab letting go cleanly queues a second request of its own on the term's lock before it says
  goodbye, and the tabs watching the term see that request and wait for the `owner-released` the
  term still owes them. A message alone therefore never ends a term.

## The message bus

The bus is an interface, `Transport`, with two implementations [ADR-0006, ADR-0007]:

- **`SharedWorkerTransport`** connects to a `SharedWorker` running the `Broker`. The broker tracks
  which tabs participate in which configuration and which tab last claimed ownership, and routes
  each message to `all` participants of a configuration, to its `owner`, or to one tab. A tab that
  dies sends no goodbye, so every tab on the worker also sends a heartbeat, and the broker forgets
  one that stays silent for three minutes. The worker can die too, and tells nobody: the broker
  answers every heartbeat, and a tab whose last three heartbeats went unanswered reports
  `BROKER_UNAVAILABLE`, starts a new worker, and restores its part there with a heartbeat
  [ADR-0021].
- **`BroadcastChannelTransport`** sends every message to every tab; each tab keeps a message only
  if it is addressed to a configuration it participates in, to a configuration it owns, or to its
  own identifier.

Because routing depends only on the addressed envelope, and ownership only on the Web Lock, the two
behave identically. Messages meant only for a broker - `hello`, `welcome`, `heartbeat`, `goodbye`,
`attach`, `detach` - reach nobody above either transport.

Every script of the origin can reach the bus as well, so the worker trusts a port with no more than
it said about itself (`WorkerPorts`). A port's first message must be `hello`, and names the identity
the port speaks as from then on; a message before it, or in another sender's name, is dropped. An
identity may have several ports - a tab that gave up on a worker that hung connects to it again on a
new one - so a later port never takes an identity's messages from its earlier ports: each of them
receives them, until the sweep finds a port silent. A `goodbye` ends only the port it arrived on. The
test harness routes through the same class. `SECURITY.md` lists what this does and does not protect.

In the default mode the worker transport is wrapped in a `FallbackTransport`. A `SharedWorker`
whose script answers 404 is still created; the browser reports the failure afterwards. So until
the broker's `welcome` arrives, the wrapper keeps everything the tab sent. If the failure comes
first, none of it reached anyone, and it is replayed over a `BroadcastChannel` — exactly once, in
order — before the tab carries on there.

The same happens when the worker script is of another protocol version, such as a copied worker
file left over from an earlier release. The `hello` and the `welcome` are the one exchange whose
shape no version may change: a worker answers every `hello`, whatever its version, with a `welcome`
in its own. A tab that receives a message in another version on the worker's port reports
`PROTOCOL_VERSION_MISMATCH` and falls back as above [ADR-0024].

Where nothing falls back — with `transport: 'sharedworker'`, or on a worker started in place of one
that died — such a worker answers `hello` and nothing else, and its silence is no crash. The tab
closes its port, stops its heartbeats and starts no other worker, since one started from the same
URL runs the same script; only a reload helps [ADR-0024, amended].

## The protocol between tabs

Every message carries `{ v, from, to, type }` and is validated completely on arrival; anything
malformed is dropped [ADR-0008]. Every field is also held to a limit - identifiers, names, payloads,
text, name lists, errors and reports, in `src/protocol/limits.ts` - and an accepted message is
rebuilt from the fields its type declares, so nothing a sender adds is passed on. A message beyond a
limit is dropped and logged once per limit, not once per message. The broker bounds what it keeps in
the same way: participants, ports per participant, and configurations.

| Message                                     | Sent by                 | Purpose                                                                     |
| ------------------------------------------- | ----------------------- | --------------------------------------------------------------------------- |
| `hello`, `goodbye`                          | every tab               | Announce a tab to the broker; leave cleanly.                                |
| `welcome`                                   | the broker              | Answers `hello` and every `heartbeat`: the worker script runs and is alive. |
| `heartbeat`                                 | every tab on the worker | Keeps a tab known to the broker, and restores what it takes part in.        |
| `attach`, `detach`                          | every tab               | Start or stop participating in a configuration.                             |
| `owner-claimed`, `owner-released`           | the owner               | A term of holding the port began; it ended, as its last message.            |
| `status-request`                            | a tab that just set up  | Asks the owner to restate the status.                                       |
| `status`                                    | the owner               | The connection status changed, with the owner's tab limit and term.         |
| `write-request`                             | a participant           | Asks the owner in one term to write.                                        |
| `write-started`, `write-result`             | the owner               | The write began, in a term; how it ended.                                   |
| `data-received`, `data-sent`                | the owner               | Traffic, to every participant.                                              |
| `error`                                     | any tab                 | A failure every participant should know about.                              |
| `diagnostics-request`, `diagnostics-report` | an observer; every tab  | The diagnostics collection [ADR-0018].                                      |

The protocol version is part of every message, of the lock names, and of the name of the worker and
the channel, and it is incremented on any change to a message. Tabs on different versions therefore
never exchange messages or contend for the same lock, and both will try to open the device. So that
they can still detect each other, every tab also announces its protocol version on
`serial-broker/announcements`, a channel whose name and single message never change [ADR-0023].
Remembered configurations carry a storage version of their own, so they survive a protocol change
[ADR-0022].

## The connection

`PortSupervisor` is a state machine [ADR-0010]:

```text
idle ──▶ opening ──▶ open ──▶ reconnecting ──▶ opening ─ …
   │                   │            │
   └▶ awaiting-permission          └▶ failed (after maxAttempts; revived by the device returning)
                                    failed (at once, from an attempt refused with a non-retryable error)
                                    stopped (when the tab stops being the owner)
```

Every way to lose a connection — a failed or timed-out `open()`, a read that fails or ends, a write
that fails or times out, a `disconnect` event — goes through one handler, which reports the error,
closes what is open, and schedules the next attempt with exponential backoff and jitter. Opening,
closing and every chunk written are bounded by a deadline, because a driver or a device that
stopped answering would otherwise hold them forever. A generation counter makes a late result from
an abandoned attempt harmless.

Writes at the port go through a queue, so the bytes of one write are never interleaved with
another's.

## Writes across tabs

A write belongs to the tab that issued it, not to the owner or the broker [ADR-0013].
`PendingWrites` in that tab holds it until a connection exists, hands it to the owner, and settles
it when the owner reports the result. The owner reports `write-started` the moment it begins, and
that marks the write as not repeatable. Because this decision lives in the issuing tab, it is the
same on both transports and does not depend on the broker.

A write request is addressed to the owner's term, and only that term writes it [ADR-0026]. A new
claim does not decide anything by itself: the former term's result may still be on its way. A term
ends when the browser frees its lock, or - for a holder that is letting go cleanly - at its
`owner-released` [ADR-0030]. Only then is a write that term began and did not answer rejected with
`OWNER_LOST_DURING_WRITE`, and a write addressed to it that it never began handed to the owner now.
`write-started` and `write-result` count only from the term the write was addressed to, and only
from the context that speaks for it. An owner that crashed after writing but before its
`write-started` arrived cannot be told from one that never received the write.

What the bus can cost a tab is bounded as well as validated [ADR-0031]: a port keeps a bounded
number of waiting writes and payload bytes, and refuses the rest with `WRITE_QUEUE_FULL`; answers
to status and diagnostics requests, records of malformed messages, errors from other tabs and the
reports one diagnostics collection keeps are rate-limited, with the drops logged once.

## Errors

There is one error class, `SerialBrokerError`, with a stable code, structured context and a
remediation sentence for every code [ADR-0012]. Errors that cross the bus are serialised and rebuilt
in the receiving tab; the original cause comes back as a plain `Error` with its name and message.
Browser exceptions are mapped to codes through an explicit table keyed on the `DOMException` name,
never on message text.

## Testing

The test suite runs in Node with no browser at all. `test/harness/` provides simulated
implementations of everything in the environment, faithful to the specifications:

- a lock manager with exclusive locks, FIFO queueing, `AbortSignal`, and release when a tab is
  killed;
- a serial registry whose devices can be plugged, unplugged, made to fail or hang on open and
  write, and made to emit data;
- a bus with both transports, the real broker, asynchronous delivery and structured cloning;
- a fake clock, so backoff delays are asserted exactly.

A test opens several simulated tabs, closes or kills them at chosen moments, and asserts what each
tab observed. Every scenario that involves coordination runs against both transports. The harness
has tests of its own, because a simulation that is wrong in the same way as the code would make
every test pass for the wrong reason.

What the simulation cannot prove is recorded in `docs/manual-test-plan.md`, which is worked through
in a real browser, with real or emulated hardware [ADR-0017].

## Decision records

| ADR  | Decision                                                                            |
| ---- | ----------------------------------------------------------------------------------- |
| 0002 | Wrap the transport only, no protocol layer                                          |
| 0003 | TypeScript, Vitest, tsup, ESLint, Prettier                                          |
| 0004 | The physical port is owned by a window, not by the worker                           |
| 0005 | Elect the port owner with the Web Locks API                                         |
| 0006 | Use a SharedWorker as the message broker                                            |
| 0007 | Fall back to BroadcastChannel when SharedWorker is unavailable                      |
| 0008 | Version the wire protocol independently                                             |
| 0009 | Identify devices by USB IDs, persist configuration, rely on browser permission      |
| 0010 | Supervise the connection with bounded exponential backoff                           |
| 0011 | Expose nothing about the coordination mechanism                                     |
| 0012 | One error type, stable codes, mandatory remediation                                 |
| 0013 | Per-participant write ordering with at-most-once delivery                           |
| 0014 | Inject the browser environment for testability                                      |
| 0015 | Deliver bytes, offer text as a configured convenience                               |
| 0016 | Support ports that are not USB devices                                              |
| 0017 | Emulate a USB serial device over USB/IP for testing without hardware                |
| 0018 | Expose coordination internals to operators through a diagnostics observer           |
| 0019 | Ship the debugging surface in the package, as static content                        |
| 0020 | Build the developer documentation with Sphinx, MyST and a TSDoc-generated reference |
| 0021 | Forget tabs that stop sending heartbeats                                            |
| 0022 | Version stored configurations separately from the protocol                          |
| 0023 | Announce the protocol version on an unversioned channel                             |
| 0024 | Keep the handshake with the worker readable by every protocol version               |
| 0025 | Limit how many tabs use a configuration at once                                     |
| 0026 | Attribute ownership, write and status messages to a term of holding the port        |
| 0027 | Keep a remembered configuration while any tab runs it                               |
