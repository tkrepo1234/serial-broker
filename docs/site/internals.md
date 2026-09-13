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
it becomes the owner it creates a `PortSupervisor`, announces `owner-claimed` on the bus, and hands
pending writes on. When it stops, it closes the port **before** releasing the lock, so the successor
never finds the device still open.

When a tab dies, the browser releases its lock and grants it to the longest-waiting request. The
successor's `owner-claimed` is also the proof, to every other tab, that the previous owner is gone.

## The message bus

The bus is an interface, `Transport`, with two implementations [ADR-0006, ADR-0007]:

- **`SharedWorkerTransport`** connects to a `SharedWorker` running the `Broker`. The broker tracks
  which tabs participate in which configuration and which tab last claimed ownership, and routes
  each message to `all` participants of a configuration, to its `owner`, or to one tab. A tab that dies sends no goodbye, so every tab on the worker also
  sends a heartbeat, and the broker forgets one that stays silent for three minutes [ADR-0021].
- **`BroadcastChannelTransport`** sends every message to every tab; each tab keeps a message only
  if it is addressed to a configuration it participates in, to a configuration it owns, or to its
  own identifier.

Because routing depends only on the addressed envelope, and ownership only on the Web Lock, the two
behave identically.

In the default mode the worker transport is wrapped in a `FallbackTransport`. A `SharedWorker`
whose script answers 404 is still created; the browser reports the failure afterwards. So until
the broker's `welcome` arrives, the wrapper keeps everything the tab sent. If the failure comes
first, none of it reached anyone, and it is replayed over a `BroadcastChannel` — exactly once, in
order — before the tab carries on there.

## The protocol between tabs

Every message carries `{ v, from, to, type }` and is validated completely on arrival; anything
malformed is dropped [ADR-0008].

| Message                                     | Sent by                 | Purpose                                                              |
| ------------------------------------------- | ----------------------- | -------------------------------------------------------------------- |
| `hello`, `goodbye`                          | every tab               | Announce a tab to the broker; leave cleanly.                         |
| `welcome`                                   | the broker              | Answers `hello`, which proves the worker script runs.                |
| `heartbeat`                                 | every tab on the worker | Keeps a tab known to the broker, and restores what it takes part in. |
| `attach`, `detach`                          | every tab               | Start or stop participating in a configuration.                      |
| `owner-claimed`, `owner-released`           | the owner               | Ownership changed.                                                   |
| `status-request`                            | a tab that just set up  | Asks the owner to restate the status.                                |
| `status`                                    | the owner               | The connection status changed.                                       |
| `write-request`                             | a participant           | Asks the owner to write.                                             |
| `write-started`, `write-result`             | the owner               | The write began; how it ended.                                       |
| `data-received`, `data-sent`                | the owner               | Traffic, to every participant.                                       |
| `error`                                     | any tab                 | A failure every participant should know about.                       |
| `diagnostics-request`, `diagnostics-report` | an observer; every tab  | The diagnostics collection [ADR-0018].                               |

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
that marks the write as not repeatable. When a new owner claims the port, every write that had not
started is handed to it; every write that had started is rejected with `OWNER_LOST_DURING_WRITE`.
Because this decision lives in the issuing tab, it is the same on both transports and does not
depend on the broker.

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
