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

| Event                             | Level | When                                                                                      |
| --------------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| `client.setup`                    | info  | A configuration was set up in this tab.                                                   |
| `client.restore`                  | info  | Remembered configurations were restored.                                                  |
| `client.release`                  | info  | A configuration was released in this tab.                                                 |
| `client.error`                    | error | A failure not tied to one configuration, such as a message bus failure.                   |
| `client.malformed-message`        | warn  | A message from another tab could not be read and was dropped.                             |
| `client.forget-failed`            | warn  | The browser could not revoke a device permission.                                         |
| `client.announcement-unavailable` | warn  | The version announcement cannot be used; tabs on other protocol versions go unnoticed.    |
| `facade.late-configure`           | warn  | `configure()` was called after the client was built; its options apply after `dispose()`. |
| `election.acquired`               | info  | This tab now holds the port.                                                              |
| `election.released`               | info  | This tab gave the port up.                                                                |
| `election.failed`                 | warn  | Requesting the ownership lock failed; the tab requests it again.                          |
| `supervisor.open`                 | info  | The port opened.                                                                          |
| `supervisor.reconnect`            | warn  | The connection was lost; the reason, attempt and delay are in the fields.                 |
| `supervisor.device-connected`     | info  | The device reappeared, and a reconnect is attempted at once.                              |
| `supervisor.sent`, `.received`    | debug | Traffic, with `byteLength`; with `logPayloads`, also `hex`.                               |
| `matcher.none`                    | debug | No granted port matches the configured device.                                            |
| `matcher.ambiguous`               | warn  | Several granted ports match; the first is used.                                           |
| `environment.transport-fallback`  | warn  | `SharedWorker` is unavailable or its script did not load; `BroadcastChannel` is used.     |
| `storage.unavailable`             | warn  | A read or write to `localStorage` failed; configurations may not be remembered.           |
| `storage.invalid-entry`           | warn  | A remembered configuration was invalid and discarded.                                     |
| `storage.corrupt`                 | warn  | The stored configurations could not be read and were discarded.                           |
| `storage.migrated`                | info  | Remembered configurations were moved from the key an earlier build used.                  |
| `slot.acquired`                   | info  | This tab took one of the `maxTabs` places and joins the configuration.                    |
| `slot.released`                   | info  | This tab gave its place up.                                                               |
| `slot.failed`                     | warn  | Requesting a place failed; the tab queues again.                                          |
| `session.tab-limit-conflict`      | warn  | The tab holding the port runs a different `maxTabs`; this tab withdrew.                   |

Payload bytes never appear above `debug`, and at `debug` only with `logPayloads: true`.

A diagnostics observer, described below, takes a logger of its own and logs under `diagnostics.*`
at `warn`: a message it could not read, a failure of the message bus, a `watch` listener that
threw, and a browser that cannot list Web Locks.

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
  next attempt is due, when the port opened, the writes queued at the port, and bytes in and out.
  The state is `opening` for the whole of an attempt — while the previous connection finishes
  closing, while the granted ports are listed, and while the port opens. The next attempt is due
  only while the state is `reconnecting`; during an attempt nothing is scheduled.
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

### Serving it

The page is plain static files. It has to be served on **the application's origin**, over HTTPS or
`localhost`, next to the worker script:

```text
dist/
├── serial-broker.worker.js
└── debug/
    ├── index.html
    └── debug.js
```

If the application loads the worker from a different URL, set it under _Settings_ on the page, or
pass it in the address: `/debug/?workerUrl=/assets/serial-broker.worker.js`. _Copy link_ produces
such an address.

### Whether to serve it

That is your decision, and a real one: the page can send bytes to devices and revoke device
permissions, and it shows traffic in full. Anyone who can open it on the application's origin can
do what the application can do. Nothing in serial-broker serves it or links to it; if it should not
be reachable in production, do not deploy `dist/debug/` there.

## Troubleshooting

**The debugging surface shows no tabs, although the application is open.**
A tab only joins the bus with its first `setup()`. If tabs have set configurations up and still do
not appear, the page and the application load the worker from different URLs, force different
transports, or run different versions of serial-broker.

**The status stays at `queued`.**
`maxTabs` tabs use the configuration, and none of them lets go. The debugging surface lists them.
A tab that is left open in the background holds its place as long as it has the configuration set
up; closing it, or releasing the configuration there, admits the next tab.

**The status stays at `awaiting-permission`.**
No port the user granted matches the device. Call `requestAccess()` from a click, in the tab that
holds the port. If a port was chosen and the status does not change, its USB IDs differ from the
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
