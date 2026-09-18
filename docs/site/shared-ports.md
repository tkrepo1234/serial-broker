# How shared ports behave

Using a serial port from one tab is simple: open it, read, write, close. Using it from every tab of
an application raises questions a single tab never has to answer: which tab opens the port, whose
settings it opens it with, what a tab in the background does, and what happens when tabs run
different versions of the application.

This chapter describes the mechanism as far as an application needs it, and the conditions it
operates under. What the mechanism promises — about writes, failover, reconnecting and received
data — is stated once, in [Guarantees](guarantees.md). How it is built is in
[Internals](internals.md).

## The shape of it

```text
 tab A                        tab B                        tab C
 ┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
 │ holds the port  ●    │     │ waiting for the lock │     │ waiting for the lock │
 └──────────┬───────────┘     └──────────┬───────────┘     └──────────┬───────────┘
            │                            │                            │
            └──── message bus: SharedWorker or BroadcastChannel ──────┘

            the ownership lock: a Web Lock, granted by the browser to one tab at a time
```

Two mechanisms, kept apart:

- **A Web Lock decides which tab holds the port.** Exactly one tab is granted it; every other tab
  that has set up the configuration waits for it.
- **A message bus carries everything else** — data from the device, writes to it, status and
  errors — between the tabs.

## One tab holds the port

For every configuration, each tab that has set it up requests a [Web Lock][web-locks] named after
it. The browser grants the lock to one tab. That tab opens the port, reads from it and performs
every write. Holding the lock _is_ holding the port: there is no separate flag that could disagree
with it and no vote between tabs. The browser releases the lock whenever the tab goes away,
however it goes away, and grants it to the tab that has waited longest — which is why failover needs
no heartbeat and no timeout.

Your application cannot see which tab holds the port, on purpose. Any answer would be out of date
by the time you acted on it, and there is nothing that tab can do that the others cannot: every tab
sends, receives and reports the same status. For people operating a deployment,
[Diagnostics](diagnostics.md) shows which tab holds each port.

## What every tab sees

Every tab that has set up a configuration receives:

- **`onReceive`** for every delivery of data from the device, with the same bytes in every tab —
  from the moment the tab knows which tab holds the port. What arrived before that is not repeated
  for it, so a tab that joins late has a shorter log, not a different one; see
  [Receiving](guarantees.md#receiving).
- **`onSend`** for every write the browser took for the port, including writes from other tabs.
  `event.origin` is `'local'` for writes this tab issued and `'remote'` for the others.
- **`onStatusChange`** whenever the status changes. The tab holding the port decides the status, and
  every tab reports the same one. A tab that sets up a configuration another tab already has open
  asks for the current status rather than waiting at `idle`.
- **`onError`** for failures of the connection, rebuilt in every tab with code, context and
  remediation; see [How errors reach the application](errors.md#how-errors-reach-the-application).

`send()` works the same in every tab. In the tab holding the port, the write goes to the port; in
any other tab, it crosses the message bus to that tab, which performs it and reports the result.
Your code cannot tell the difference. What the result means is in
[Guarantees](guarantees.md#write-outcomes).

## Whose settings apply

Every tab sets up a configuration with its own options, and serial-broker does not compare most of
them between tabs: the tab holding the port opens, reads and reconnects with its own settings, and
when the port moves to another tab, that tab's settings apply. So **pass the same options for a name
in every tab**. [Whose settings apply](configuration.md#whose-settings-apply) says which option is
taken from which tab.

## Permission, and remembering devices

Two things are remembered between visits, by two different parties:

- **The browser remembers which port the user chose** for the origin. serial-broker cannot grant,
  store or forge this permission. `release(name, { forgetDevice: true })` revokes it.
- **serial-broker remembers the configuration** in `localStorage`, unless it is set up with
  `remember: false`. `restore()` sets up every remembered configuration, and `setup()` in auto mode
  takes the device the user chose from it.

**Releasing forgets neither.** `release(name)` stops using the configuration in this tab and closes
the port if this tab held it; the configuration stays remembered and the permission stays granted,
so `restore()`, or the next `setup()`, connects again without a prompt. A disconnect is not a
deletion — a screen on a production line that disconnects in the evening finds its device again in
the morning.

Forgetting is asked for, one store at a time: `{ forget: true }` drops the remembered configuration,
`{ forgetDevice: true }` revokes the browser's permission, and both together leave no trace of the
configuration in this browser; see [`release()`](configuration.md#release).

What is remembered belongs to the origin, not to one tab: `{ forget: true }` removes the entry only
when no other tab still runs the configuration with `remember: true`, and a tab that is closed,
reloaded or crashes forgets nothing. Details are in [`remember`](configuration.md#remember).

Any tab taking part in a configuration can ask the user for permission: the permission belongs to the
origin. A tab that does not hold the port shows the picker, and the tab holding the port then looks for
the granted port again and opens it — in auto mode with the device the user chose, which it adopts.
In a tab that does not hold the port, `requestAccess()` resolves `true` without asking when the status
is already `open`; the tab holding the port shows the picker whatever its status. Called with
`{ chooseAgain: true }`, it always shows the picker, to choose a different device in auto mode; see
[`device`](configuration.md#device). A tab that has just
set the configuration up may ask at once — `setup()` and `requestAccess()` in one click. Only a tab
`queued` under `maxTabs`, or one that withdrew, rejects with `PERMISSION_REQUIRED`.
[First connection](first-connection.md#3-ask-for-permission-once) shows the usual pattern.

## Limiting how many tabs use a port

By default every tab that sets a configuration up uses it. With `maxTabs`, at most that many do at
the same time, the tab holding the port included; `maxTabs: 1` gives one tab exclusive use.

```ts
await SerialBroker.setup('Press', {
  device: { vendorId: 0x0403, productId: 0x6001 },
  serial: { baudRate: 115_200 },
  maxTabs: 1,
});
```

A tab beyond the limit shows the status `queued`. It receives nothing, and a write it issues waits
for its deadline. When a tab releases the configuration, is closed or crashes, the tab that has
waited longest takes its place and goes on like any other tab — holding the port, if that place is
free. The places are Web Locks, so the browser frees a crashed tab's place as it frees the port. A
tab whose configuration is `failed` keeps its place until it releases the configuration or goes
away.

Every tab has to pass the same limit. A tab that finds the tab holding the port running a different
one reports `CONFIGURATION_CONFLICT`, withdraws, and shows `failed` until it is released and set up
again with the same limit. Only tabs of this origin are counted: another program or site holding the
port makes opening it wait, but takes no place.

## The message bus

Tabs exchange messages through a `SharedWorker` by default. The worker only passes messages on: it
does not open the port, decide which tab holds it, or keep writes. Where no `SharedWorker` is
available, the browser refuses to create one, or its script does not load, serial-broker uses a
`BroadcastChannel` instead, and behaves the same. Nothing a tab sent before the switch is repeated:
over the channel, the tab restates its status, or asks for the status of the tab holding the port,
as it does after reaching a new worker. Traffic sent in between is lost.

Every tab must load the worker script from **the same URL**. Tabs that load it from different URLs
are connected to different workers, cannot see each other, and compete for the device; see
[The worker script](installing.md#the-worker-script).

## Tabs running different versions

Tabs that run different versions of serial-broker's internal message protocol do not coordinate:
they use different lock names and different workers, and each group behaves as if it were alone.
Both groups try to hold the device, and the group that comes second cannot open it and keeps
reconnecting.

They do notice each other. A tab announces its protocol version when it sets up its first
configuration, on a channel whose name no version changes, and answers announcements from other
versions. A tab that learns of another version reports `PROTOCOL_VERSION_MISMATCH` through
`onError`, once per version. After deploying a version that changes the protocol, reload every open
tab; the changelog says when that is necessary.

## Fast devices and large writes

**Reading.** The tab holding the port reads what the browser hands over — at most
`serial.bufferSize` bytes at a time — collects it as [`receive`](configuration.md#receive)
describes, and sends each delivery to every tab as one message. Its own `onReceive` listeners run on
the same thread that reads the port, so a slow listener there delays reading; the browser's read
buffer then fills, and a device without flow control loses what does not fit. In the other tabs,
deliveries that a busy tab cannot handle yet wait in the browser's queue for that tab, which
serial-broker can neither see nor limit. Keep `onReceive` listeners short, and hand heavy work to a
later task.

**Writing.** One `send()` is one message to the tab holding the port, and one more to every tab when
it has been written, for `onSend`. A 16 MiB payload is therefore copied into every tab, several times
over while it is in flight. The tab holding the port hands it to the device in chunks of
`connection.maxWriteChunkBytes`, one at a time, and each chunk has `connection.writeTimeoutMs` to be
taken. The whole `send()` has `connection.writeTimeoutMs` as well, timed by the issuing tab's own
setting; see [Write outcomes](guarantees.md#write-outcomes). For a large payload to a slow device,
raise it to cover the whole write — up to ten minutes — or send the data as several calls, between
which writes from other tabs may come.

## Tabs that run for a long time

A tab of an operator's screen may stay open for weeks. Browsers do several things to such a tab that
it is told about late, or not at all. serial-broker waits with timers, and measures durations on
`performance.now()`, which the system clock moving does not change.

### Hidden tabs

A browser runs the timers of a hidden tab late: Chromium aligns them to whole seconds, and after five
minutes hidden, runs repeating timers only once a minute. Messages between tabs and device events
are not held back. In a hidden tab, deadlines and reconnect delays can therefore end up to a minute
late, and write timeouts take that much longer. Learning that the tab holding the port has gone does
not: it is a Web Lock being freed, not a timer, and the browser grants a waiting tab that lock as
promptly in a hidden tab as in a visible one. The same holds for learning that the worker has ended,
or that a tab has gone: both are Web Locks too.

A deadline that runs a second or more late first handles the messages that arrived meanwhile, so a
write whose result is already waiting resolves instead of timing out.

### Frozen tabs

Chromium freezes hidden tabs to save energy: a frozen tab runs nothing until it is shown again.
It does not freeze a tab that uses Web Serial, or that holds a Web Lock another tab is waiting
for — so neither the tab holding the port, nor a tab holding a place that another tab queues for
under `maxTabs`, is frozen by that policy. Other tabs can be. A frozen tab hears nothing and sends
nothing. A write of its own that had begun goes on and its result waits for the tab; one that had not
begun is not begun while the tab is frozen, and is rejected with `WRITE_TIMEOUT` and `started: false`
once the `writeTimeoutMs` of the tab holding the port has passed. It still holds its Web Locks, so
the worker keeps it. When it is shown again, its overdue timers and the messages that arrived
meanwhile run in no defined order; as for a hidden tab, a deadline that is late handles the waiting
messages first, so a write that succeeded meanwhile resolves.

### What serial-broker cannot know

A tab holding the port that stops running without going away — frozen by a browser whose policy
differs, paused in a debugger, or blocked by a long task — keeps its lock, and so keeps the port. No
other tab can take over: the browser grants the lock only when that tab lets go or disappears.
Meanwhile the other tabs receive nothing, and their writes reject with `WRITE_TIMEOUT` and
`started: false`. Nothing distinguishes such a tab from one whose device is quiet. Taking the port
from it would break the promise that only one tab writes to the device, so serial-broker does not;
when the tab runs again, it carries on where it stopped.

### Leaving the page, and discarded tabs

serial-broker listens for no page lifecycle events. In Chromium, a page that holds a Web Lock, uses
Web Serial or listens on a `BroadcastChannel` is not kept in the back/forward cache, and a tab with a
configuration set up does all three, so navigating away unloads it like closing it: the browser
closes its port and lets its locks go, and the worker forgets the tab as soon as it does. To close
the port before the lock is let go, call
`SerialBroker.dispose()` in a `pagehide` listener. Should a browser restore such a page from the
cache anyway — `pageshow` with `persisted` set — set its configurations up again.

A tab the browser discards to save memory is gone, as if it had crashed, and another tab takes over.
When the user returns to it, the page loads again, with `document.wasDiscarded` set, and `restore()`
brings its remembered configurations back.

### Sleep, and changes to the system clock

When a computer sleeps, every tab and the worker stop together, and when it wakes, their overdue
timers run. USB adapters are often reset on wake; the tab holding the port then reconnects as for
any unplugged device. No tab is forgotten for having slept: who is still there is a Web Lock, not a
timer.

Setting or correcting the system clock — by the user, a time zone change or an NTP step — affects
nothing serial-broker times: every duration is read from `performance.now()`, which counts on
regardless of the system clock. Timestamps are the other half: the `timestamp` of an event or an
error, and the moments in a diagnostics report, are system-clock readings, so that they agree with
the application's own logs. They jump with the clock, and two machines whose clocks differ stamp the
same moment differently.

## What to watch out for

- Pass the same options for a configuration name in every tab, including the same `maxTabs`.
- Serve the worker script from one URL, and set `workerUrl` before the first `setup()`.
- Call `requestAccess()` directly inside a click handler, in response to `awaiting-permission`.
- Treat an `onReceive` delivery as an arbitrary piece of the byte stream, never as a message, and
  keep listeners short — above all for a device that sends quickly.
- Decide, per command, whether it may be repeated after `OWNER_LOST_DURING_WRITE`.
- Show `queued` to the user as waiting, not as an error, and handle status values you do not
  recognise: the list may grow.

[web-locks]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
