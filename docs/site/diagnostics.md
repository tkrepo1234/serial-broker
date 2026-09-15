# Diagnostics

Three tools show what serial-broker is doing, for different people at different times:

| Tool                                                        | For                      | Shows                                       |
| ----------------------------------------------------------- | ------------------------ | ------------------------------------------- |
| [Logging](#logging)                                         | Developers, support logs | What one tab did, as a stream of records.   |
| [`serial-broker/diagnostics`](#the-diagnostics-entry-point) | Tools and operators      | The current state of every tab, on request. |
| [The debugging surface](#the-debugging-surface)             | Operators, testers       | That state as a page, with actions on it.   |

## Logging

serial-broker writes nothing to the console on its own. To see its records, pass a logger before
the first `setup()`:

```ts
import { SerialBroker } from 'serial-broker';

SerialBroker.configure({
  logger: {
    log(level, message, fields) {
      console[level](`[serial-broker] ${message}`, fields);
    },
  },
});
```

A logger must not throw. If it does, the record is dropped and the operation carries on.

### What a record carries

Every record has a level (`debug`, `info`, `warn`, `error`), a message, and fields. Records about
a configuration include:

`clientId`
: The tab that wrote the record. Records collected from several tabs can be told apart by it.

`configName`
: The configuration the record concerns, where there is one.

`event`
: A stable dotted identifier such as `supervisor.reconnect`. Filter on this rather than on the
message.

### What is logged

| Event                                     | Level | When                                                                                                                                                                                                                     |
| ----------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `client.setup`                            | info  | A configuration was set up in this tab.                                                                                                                                                                                  |
| `client.restore`                          | info  | Remembered configurations were restored.                                                                                                                                                                                 |
| `client.release`                          | info  | A configuration was released in this tab.                                                                                                                                                                                |
| `client.error`                            | error | A failure not tied to one configuration, such as a message bus failure.                                                                                                                                                  |
| `client.malformed-message`                | warn  | A message from another tab could not be read and was dropped. Once per kind of fault.                                                                                                                                    |
| `client.forget-failed`                    | warn  | The browser could not revoke a device permission.                                                                                                                                                                        |
| `client.dispose-failed`                   | warn  | A cleanup step failed while the client was disposed; `reason` says which.                                                                                                                                                |
| `client.announcement-unavailable`         | warn  | The version announcement cannot be used; tabs on other protocol versions go unnoticed.                                                                                                                                   |
| `client.peer-versions-limit`              | warn  | More protocol versions were heard of than are reported (8); further ones are not. Once.                                                                                                                                  |
| `client.unheard-errors-dropped`           | warn  | More than 16 errors arrived with no `onError` listener; the oldest are dropped. Once.                                                                                                                                    |
| `client.diagnostics-answers-dropped`      | warn  | Diagnostics requests arrived faster than they are answered; the rest go unanswered. Once.                                                                                                                                |
| `facade.late-configure`                   | warn  | `configure()` was called after the client was built; its options apply after `dispose()`.                                                                                                                                |
| `election.acquired`                       | info  | This tab now holds the port.                                                                                                                                                                                             |
| `election.released`                       | info  | This tab gave the port up.                                                                                                                                                                                               |
| `election.failed`                         | warn  | Requesting the ownership lock failed; the tab requests it again.                                                                                                                                                         |
| `supervisor.open`                         | info  | The port opened.                                                                                                                                                                                                         |
| `supervisor.reconnect`                    | warn  | The connection was lost; the reason, attempt and delay are in the fields.                                                                                                                                                |
| `supervisor.gave-up`                      | warn  | An attempt failed with an error that is not retryable; the status becomes `failed`.                                                                                                                                      |
| `supervisor.device-connected`             | info  | The device reappeared, and a reconnect is attempted at once.                                                                                                                                                             |
| `supervisor.device-changed`               | info  | The user chose a different device in auto mode: the old port is closed and the new device looked for.                                                                                                                    |
| `supervisor.teardown-failed`              | debug | Closing a lost connection failed or timed out at `step`; the next open may find it open.                                                                                                                                 |
| `supervisor.write-stalled`                | warn  | The device did not take a write within `writeTimeoutMs`. The write stays in flight and holds the queue, and the connection stays open (ADR-0038); the tab holding the port reports `stalledWriteSince` until it settles. |
| `supervisor.write-expired`                | debug | A write waited `writeTimeoutMs` behind others and was not begun; `queuedWrites` remain.                                                                                                                                  |
| `supervisor.sent`                         | debug | Bytes the browser took for the port, with `byteLength`; with `logPayloads`, also `hex`.                                                                                                                                  |
| `supervisor.received`                     | debug | Bytes read from the port, with `byteLength`; with `logPayloads`, also `hex`.                                                                                                                                             |
| `session.device-resolved`                 | info  | Auto mode took its device from the picker (`source: 'picker'`), the holder (`'holder'`) or the remembered entry (`'remembered'`).                                                                                        |
| `matcher.none`                            | debug | No granted port matches the configured device, or none is chosen yet (`filter: 'auto'`).                                                                                                                                 |
| `matcher.ambiguous`                       | warn  | Several granted ports match; the first is used.                                                                                                                                                                          |
| `environment.transport-fallback`          | warn  | `SharedWorker` is unavailable or its script did not load; `BroadcastChannel` is used.                                                                                                                                    |
| `transport.broker-lost`                   | warn  | The worker ended - its lock was let go - or did not answer in time; a new worker is started.                                                                                                                             |
| `transport.worker-restarted`              | info  | A new worker was started in place of the lost one.                                                                                                                                                                       |
| `transport.worker-restart-failed`         | warn  | Starting a new worker failed; the handshake deadline tries again.                                                                                                                                                        |
| `transport.broker-restored`               | info  | A new worker welcomed the tab.                                                                                                                                                                                           |
| `transport.worker-other-protocol-version` | warn  | The worker runs another protocol version; the tab uses no worker until it is reloaded.                                                                                                                                   |
| `transport.dispose-failed`                | warn  | A cleanup step failed while the message bus was closed.                                                                                                                                                                  |
| `transport.limit-exceeded`                | warn  | A message beyond a limit of the bus was dropped; once per `limit`.                                                                                                                                                       |
| `transport.context-lock-failed`           | warn  | The lock that shows the worker this tab is there could not be taken; the tab says hello anyway, and the worker cannot tell when it has gone. Once.                                                                       |
| `transport.worker-watch-failed`           | warn  | The lock of the `SharedWorker` could not be waited on; the tab does not learn that the worker ended. Once.                                                                                                               |
| `storage.unavailable`                     | warn  | A read or write to `localStorage` failed; configurations may not be remembered.                                                                                                                                          |
| `storage.invalid-entry`                   | warn  | A remembered configuration was invalid and discarded.                                                                                                                                                                    |
| `storage.corrupt`                         | warn  | The list of remembered configurations could not be read and was discarded.                                                                                                                                               |
| `storage.stale-name`                      | info  | A remembered name had no configuration left under it and was forgotten.                                                                                                                                                  |
| `storage.lookup-failed`                   | debug | `setup()` could not read the remembered configuration of its name; it starts as if none were remembered.                                                                                                                 |
| `storage.hold-failed`                     | warn  | The lock that keeps a remembered configuration for other tabs could not be requested.                                                                                                                                    |
| `slot.acquired`                           | info  | This tab took one of the `maxTabs` places and joins the configuration.                                                                                                                                                   |
| `slot.released`                           | info  | This tab gave its place up.                                                                                                                                                                                              |
| `slot.failed`                             | warn  | Requesting a place failed; the tab queues again.                                                                                                                                                                         |
| `session.tab-limit-conflict`              | warn  | The tab holding the port runs a different `maxTabs`; this tab withdrew.                                                                                                                                                  |
| `session.term-not-held`                   | warn  | A message named a time of holding the port that nobody holds; it was ignored. Once.                                                                                                                                      |
| `session.term-flood`                      | warn  | More times of holding the port were named than a tab keeps; the oldest check gave way. Once.                                                                                                                             |
| `session.term-check-failed`               | warn  | The browser refused the lock request that checks a term; the message was ignored and the term is checked again when it is next named.                                                                                    |
| `session.term-watch-failed`               | warn  | The browser refused the lock request that watches a term for its end.                                                                                                                                                    |
| `session.status-answers-throttled`        | warn  | Status requests arrived faster than they are answered; the rest are coalesced. Once.                                                                                                                                     |
| `supervisor.write-queue-full`             | warn  | A write was refused because the port already holds as many as it keeps. Once.                                                                                                                                            |
| `session.data-without-a-term`             | warn  | Device data or an error arrived from a context speaking for no known time of holding the port; it was dropped. Once.                                                                                                     |
| `worker.message-refused`                  | warn  | A port on the worker said something it may not; `reason` says what. Once per reason.                                                                                                                                     |
| `worker.limit-exceeded`                   | warn  | The worker dropped what exceeds a limit; once per `limit`.                                                                                                                                                               |
| `broker.limit-exceeded`                   | warn  | The broker keeps as many configurations as it may; further ones are not routed. Once.                                                                                                                                    |
| `worker.other-protocol-version`           | warn  | A tab of another build reached this worker script and was answered; it takes no part.                                                                                                                                    |
| `worker.message-error`                    | warn  | A message could not be cloned into the worker and was lost; the port stays open.                                                                                                                                         |
| `worker.lock-failed`                      | error | The worker could not take the lock it holds for its lifetime; it welcomes no tab, and the tabs treat it as a worker that does not answer.                                                                                |

Payload bytes never appear above `debug`, and at `debug` only with `logPayloads: true`.

A diagnostics observer, described below, takes a logger of its own and logs under `diagnostics.*`
at `warn`: a message it could not read, a failure of the message bus, a `watch` listener that
threw, a browser that cannot list Web Locks, and, as `diagnostics.limit-exceeded`, reports beyond
what one collection keeps.

The `worker.*` and `broker.*` records are written in the `SharedWorker`, which can reach no logger of
its own. It sends them to the tabs connected to it, and each tab writes them to its own logger, with
the fields the worker recorded. Two of those fields differ from every other record:

`clientId`
: The context the worker's record concerns — another tab, or a script of the origin — and absent
where the record concerns none. It is never the tab that wrote the record.

`reportedBy`
: The tab that wrote this copy. Every connected tab writes one, so a log collected from several tabs
holds the same record once per tab.

The worker writes each kind of warning once, so it forwards few records however much it is sent.
Records below `warn` stay in the worker, and a tab that
connects later is not told what was recorded before it arrived.

`transport.limit-exceeded` means that something on the bus sent a message no tab of this version
sends: a tab of another build, a bug, or a script of the origin that is not serial-broker. What such a
script can and cannot do is described in the repository's `SECURITY.md`.

Logging is per tab: a logger sees the records of the tab it was configured in. To follow what
happens across tabs, collect records from each — or use the diagnostics entry point below.

## The diagnostics entry point

The main API deliberately does not say which tab holds a port: application code that branched on
it would be wrong a moment later. People operating an application need exactly that information,
so a separate entry point provides it:

```ts
import { openDiagnostics } from 'serial-broker/diagnostics';

const diagnostics = openDiagnostics({ workerUrl: '/assets/serial-broker.worker.js' });

const snapshot = await diagnostics.collect();
for (const tab of snapshot.participants) {
  for (const configuration of tab.configurations) {
    console.log(tab.clientId, configuration.name, configuration.role, configuration.status);
  }
}

diagnostics.close();
```

`openDiagnostics()` joins the message bus as an **observer**. It sets nothing up and never
requests an ownership lock, so looking at a deployment never changes which tab holds a port. It
must use the same `workerUrl` and `transport` as the application; on a different worker it sees
nobody.

### Collecting

`collect(windowMs)` asks every tab for a report and listens for `windowMs` milliseconds, 500 by
default — nothing on the bus says how many tabs exist, so it cannot know when the last one has
answered. A tab answers once it has set up at least one configuration. The snapshot contains:

- **Per tab:** its identifier, its transport, and every configuration it has set up.
- **Per configuration:** the role (`owner` or `participant`), status and when it was entered, the
  last error code, the effective settings, the number of listeners per event, and pending writes —
  how many are waiting, how many were handed to the tab holding the port, how many had started.
- **For the tab holding the port:** the connection's internal state, the attempt count, when the
  next attempt is due, when the port opened, the writes queued at the port, bytes in and out, and
  `stalledWriteSince` — since when a write has been stuck at the device, while one is. An attempt is
  `listing` while the previous connection finishes closing and the granted ports are listed, and
  `opening` while the port it found opens. The next attempt is due only while the state is
  `reconnecting`; during an attempt nothing is scheduled.
- **The Web Locks** serial-broker holds and waits for, where the browser can list them. The browser
  identifies the tabs in this list differently from serial-broker, so the two cannot be matched up.

A snapshot describes a moment that is over by the time it is read. Show it; do not build logic on
it.

### Watching

`watch(name, listener)` streams one configuration's traffic, status changes, errors, and changes
of ownership, from whichever tab they happen in:

```ts
const stop = diagnostics.watch('Scale', (event) => {
  if (event.kind === 'owner-claimed') {
    console.info(`the port moved to ${event.from}`);
  }
});
```

Watching does not set the configuration up.

## The debugging surface

The package ships a page in `dist/debug/` that lists every configuration on the origin, with its
status, its device, how many tabs use it, and whether the page itself is connected to it. Choosing
one shows the tabs using it and which one holds the port, reconnect timing, pending writes, the
traffic of every tab, and all of its settings. From there the page can connect to it, choose the
device, send to it, edit its settings or disconnect. _New configuration_ sets one up with every
option available.
The page sets nothing up by itself, so opening it to look never makes it take a port.

### Starting from it

It is also the shortest way to your first connection, before you write any code. Serve `dist/`,
open `/debug/`, and press **Choose a device…**: the dialog asks for a name that is free on this
origin and the line settings, starting at 9600 baud, and nothing about the device. **Connect** sets
the configuration up in auto mode and opens the browser's port picker with no filter, in that same
click; the port you pick becomes the configuration's device — its USB IDs, or the fact that it has
none — and is remembered, so no later visit asks again. Send a line on the _Traffic_ panel to see
the device answer, and copy the settings from the _Settings_ panel into your own `setup()` call,
with or without the device it resolved to:

```ts
await SerialBroker.setup('Device', {
  device: { vendorId: 0x1a86, productId: 0x7523 },
  serial: { baudRate: 9600 },
});
```

Closing the picker without choosing sets nothing up. If several ports the browser allows match the
device, the configuration opens the first of them: identical devices report identical IDs, and the
log says so (`matcher.ambiguous`).

### Serving it

The page is plain static files. It has to be served on **the application's origin**, over HTTPS or
`localhost`, next to the worker script:

```text
dist/
├── serial-broker.worker.js
└── debug/
    ├── index.html
    ├── debug.css
    └── debug.js
```

If the application loads the worker from a different URL, set it under _Settings_ on the page, or
pass it in the address: `/debug/?workerUrl=/assets/serial-broker.worker.js`. _Copy link_ produces
such an address.

The page runs the worker script with the rights of the application's origin, so it asks before it
uses a worker URL that only the address names. Declined, the page stays on its saved or default
worker. A worker URL of another origin, or a `data:` or `blob:` URL, is never used.

### Whether to serve it

That is your decision, and a real one: the page can send bytes to devices and revoke device
permissions, and it shows traffic in full. Anyone who can open it on the application's origin can
do what the application can do. Nothing in serial-broker serves it or links to it; if it should not
be reachable in production, do not deploy `dist/debug/` there.

If you serve it, put it behind the application's own authentication for operators. The page brings
a strict `Content-Security-Policy` of its own — no inline script, no inline style, nothing loaded
from anywhere but its own origin — so it holds however you serve it. Add a header with
`frame-ancestors 'self'`, which a page cannot set for itself;
[debug/README.md](https://github.com/tkrepo1234/serial-broker/blob/main/debug/README.md) has both
policies. Without that header, the page still refuses to start inside a page of another origin,
where that page could lay its own content over the page's buttons.

## Troubleshooting

**The debugging surface shows no tabs, although the application is open.**
A tab only joins the bus with its first `setup()`. If tabs have set configurations up and still do
not appear, the page and the application load the worker from different URLs, force different
transports, or run different versions of serial-broker.

**The status stays at `queued`.**
`maxTabs` tabs use the configuration, and none of them lets go. The debugging surface lists them.
A tab that is left open in the background holds its place as long as it has the configuration set
up; closing it, or releasing the configuration there, admits the next tab.

**The status stays at `failed` although the device is back.**
The configuration runs with `connection.autoReconnect: false`, which retries nothing, or it gave up
over an attempt the browser refused. Call `setup()` again with the same options, in any tab. A tab
that reported `CONFIGURATION_CONFLICT` over a different `maxTabs` has to be released and set up
again with the same limit.

**The status stays at `awaiting-permission`.**
No port the user granted matches the device. Call `requestAccess()` from a click, in any tab that
uses the configuration. If a port was chosen and the status does not change, its USB IDs differ from the
configured ones; the rejection is `DEVICE_MISMATCH` with both sets of IDs in its context.

**Writes time out while the status is `open`.**
The device does not accept data: it is switched off behind a powered adapter, `flowControl` is
`'hardware'` with a device that never signals ready, or the line settings are wrong.

**A tab keeps reconnecting while the device is connected and works in another tab.**
Most often the tabs run different versions of serial-broker: they cannot share the port, both try
to hold the device, and the second cannot open it. Such tabs report `PROTOCOL_VERSION_MISMATCH`. The
debugging surface only shows the tabs on its own version. Reload every tab. If all tabs are current,
another program has the device open.

**Received text contains replacement characters.**
The line settings or `encoding` do not match the device.
