# How shared ports behave

Using a serial port from one tab is simple: open it, read, write, close. Using it from every tab
of an application raises questions that a single tab never has to answer. Who opens the port?
What happens to a command that was on its way when that tab closed? Does every tab see the same
thing? What arrives while the port is changing hands?

This chapter answers them: first how serial-broker coordinates tabs, then what that means for an
application — what it can rely on, and what it has to watch out for.

## The shape of it

```text
 tab A                        tab B                        tab C
 ┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
 │ holds the port  ●    │     │ waiting for the lock │     │ waiting for the lock │
 └──────────┬───────────┘     └──────────┬───────────┘     └──────────┬───────────┘
            │                            │                            │
            └──────────── message bus: SharedWorker or BroadcastChannel ──────┘

            the ownership lock: a Web Lock, granted by the browser to one tab at a time
```

Two mechanisms, kept strictly apart:

- **A Web Lock decides which tab holds the port.** Exactly one tab is granted it; every other tab
  that uses the configuration is queued for it.
- **A message bus carries everything else** — data from the device, writes to it, status and
  errors — between the tabs.

## One tab holds the port

For every configuration, each tab that has set it up requests a [Web Lock][web-locks] named after
it. The browser grants the lock to one tab. That tab is the **owner**: it opens the port, reads
from it, and performs every write. The other tabs are **participants** queued behind it.

Holding the lock _is_ being the owner. There is no separate flag that could disagree with it, no
election protocol between tabs, and no heartbeat. This matters most when things go wrong, because
the browser releases a tab's locks whenever that tab goes away, however it goes away — closed,
reloaded, crashed, killed from the task manager, a laptop lid shut — and grants the lock to the
tab that has waited longest.

Your application cannot see which tab is the owner, and this is on purpose. Any answer would be
out of date by the time you acted on it, and there is nothing an owner can do that a participant
cannot: every tab can send, receive and watch the status. For people operating a deployment,
[Diagnostics](diagnostics.md) shows the owner of every port.

## What every tab sees

Every tab that has set up a configuration receives:

- **`onReceive`** for every chunk the device sends, with the same bytes in every tab.
- **`onSend`** for every write that reached the device — including writes from other tabs.
  `event.origin` is `'local'` for writes this tab issued and `'remote'` for the others.
- **`onStatusChange`** whenever the connection status changes. The owner decides the status;
  every tab reports the same one.
- **`onError`** for failures that affect the configuration: a device that went away, a write that
  failed. The error is rebuilt in each tab with its code, context and remediation.

A tab that sets a configuration up while another tab already has the port open asks the owner for
the current status, so it does not sit at `idle` until something changes.

Data only reaches tabs that have set the configuration up. A tab that has not, sees nothing.

## Writing from any tab

`send()` works the same in every tab. In the owner, the write goes straight to the port; in a
participant, it crosses the message bus to the owner, which performs it and reports the result.
Your code cannot tell the difference, and does not need to.

What you can rely on:

- **Writes from one tab arrive in the order that tab issued them.**
- **The bytes of one `send()` are never interleaved** with the bytes of another, even when a large
  payload is split into chunks of `connection.maxWriteChunkBytes` for a device with a small
  buffer.
- **The promise resolves when the bytes were handed to the device** — not when the device acted on
  them. A serial port cannot report that.
- **A write waits for a connection** that is not open yet, for up to `connection.writeTimeoutMs`,
  and then rejects with `WRITE_TIMEOUT`.
- **A write that rejected with `WRITE_TIMEOUT` and `started: false` is never written afterwards.**
  That includes a write queued behind a slow one: a write that has waited at the tab holding the
  port for `connection.writeTimeoutMs` is taken out of the queue and not begun, so it can safely be
  sent again.

What you cannot rely on:

- **Writes from different tabs have no defined order.** If tab A and tab B send at the same time,
  either may reach the device first. If a sequence of commands must not be interrupted by another
  tab, coordinate that in your application, for example with a Web Lock of your own around the
  sequence.

## When the tab holding the port goes away

The browser releases the ownership lock and grants it to the next tab in the queue. That tab
opens the port with the same settings and carries on. From the application's point of view in the
remaining tabs, the status goes through `reconnecting` or `connecting` and returns to `open`.

Three things happen during a handover that an application should know about.

### Data sent by the device in between is lost

When the owner goes away, the browser closes its port. Until the next owner has opened it, nothing
is reading. Whatever the device sends in that gap — usually well under a second — reaches no tab.
This is a property of the platform, not of serial-broker, and no library can recover it. If your
device sends unsolicited data that must not be missed, have your protocol acknowledge it.

### A write that had not started yet is sent again

A participant's write that was still waiting — queued at the owner, or on its way to it — never
reached the device. serial-broker hands it to the new owner, and it is written exactly once. When
the tab holding the port closed, that happens as soon as its goodbye arrives; when it crashed, after
a grace period of one second, because what it sent just before crashing may still be on its way.

### A write that had started ends with `OWNER_LOST_DURING_WRITE`

A write that the old owner had already begun handing to the device is different. Some, all or none
of its bytes may have reached the device, and nothing can tell which. serial-broker rejects the
promise with `OWNER_LOST_DURING_WRITE` and **does not send it again**.

A tab that closes finishes the writes it began and reports their results before it lets go, so a
write it completed resolves, even when another tab hears of the new owner first. A tab that crashes
reports nothing more: the write is rejected once a second has passed without word from it. Two
cases remain that no library can decide. A tab that crashes after handing the bytes to the device
but before its report that it began reaches the issuing tab looks exactly like one that never
received the write, and so does a report delayed by more than that second; such a write is handed
to the new owner and may reach the device twice.

| When the owner went away, the write had… | Outcome                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| not reached it yet                       | Sent by the new owner. Delivered once.                   |
| started                                  | Rejected with `OWNER_LOST_DURING_WRITE`. Not sent again. |

Repeating a command is not always harmless. A second "dispense", "cut" or "move 10 mm" is worse
than none. Only your application knows which of its commands are safe to repeat:

```ts
import { SerialBrokerError, SerialBrokerErrorCode } from 'serial-broker';

async function sendCommand(command: string, isIdempotent: boolean): Promise<void> {
  try {
    await SerialBroker.send('Printer', command);
  } catch (error) {
    const ownerLost =
      error instanceof SerialBrokerError &&
      error.code === SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE;
    if (ownerLost && isIdempotent) {
      await SerialBroker.send('Printer', command);
      return;
    }
    throw error;
  }
}
```

The error is rejected in the tab that issued the write. A write issued by the owner itself is
lost with that tab and has no one to report to.

## When the device goes away

The owner watches for every way a connection can be lost — the device unplugged, a read or write
that fails, a stream that ends, an `open()` that does not complete — and handles them all the same
way: the status becomes `reconnecting` in every tab, and the owner tries again.

- **The first retry is immediate.** A device that was power-cycled is usually back at once.
- **Later retries back off exponentially with jitter**, from `connection.initialDelayMs` (250 ms)
  by `connection.factor` (2) up to `connection.maxDelayMs` (30 s), each delay randomised down to
  `connection.jitter` (half) of its value. Many tabs and devices that failed together therefore do
  not retry together.
- **When the browser reports that the device is back**, the owner retries at once instead of
  waiting out the delay.
- **The attempt counter resets** only after a connection has held for
  `connection.stableAfterMs` (5 s), so a device that opens and immediately drops does not retry in
  a tight loop.
- **While an unplugged device stays away**, the status stays `reconnecting`. The browser does not
  list a port whose device is unplugged, so every retry that does not find it counts as a failed
  attempt, backs off, and counts towards `connection.maxAttempts`.
- **After `connection.maxAttempts`** (unlimited by default) the status becomes `failed`, and the
  error `RECONNECT_EXHAUSTED` is reported once. A failed configuration comes back by itself when the
  device is plugged in again.
- **An attempt the browser refuses is not repeated.** When opening the port, or listing the granted
  ports, fails with `WEB_SERIAL_UNAVAILABLE` — serial access blocked by a permissions policy — every
  further attempt would meet the same refusal. The status becomes `failed` at once, with no
  `RECONNECT_EXHAUSTED`. As after `connection.maxAttempts`, the device being plugged in again tries
  once more, and so does releasing the configuration and setting it up again.
- **Only the port the tab holds counts.** Unplugging another port leaves the connection alone,
  even when the configuration matches that port too — with `device: { any: true }`, or with two
  identical adapters.
- **A new attempt waits for the lost connection to be closed**, and so does handing the port to
  another tab: until the browser has closed the port, opening it again fails.

The status becomes `awaiting-permission` rather than `reconnecting` when the port disappears
without the browser reporting the device unplugged: the user took the permission away in the site
settings, or it was revoked with `forgetDevice`. serial-broker tells the two apart by whether the
browser reported the port it holds as disconnected. If that report arrives after a retry already
found the port missing, the status moves on from `awaiting-permission` to `reconnecting`.

A device that is switched off while its USB adapter stays plugged in is the hardest case: the port
stays open and simply stops answering. Reads wait; a write does not complete and fails after
`connection.writeTimeoutMs` with `WRITE_TIMEOUT`, which starts reconnection like any other loss.

Writes issued while the status is `reconnecting` wait for the connection, within their own
timeout.

## Permission, and remembering devices

Two things are remembered between visits, by two different parties:

- **The browser remembers which port the user chose.** serial-broker cannot grant, store or
  forge this permission. `release(name, { forgetDevice: true })` revokes it.
- **serial-broker remembers the configuration**, in `localStorage`, unless you set
  `persist: false`. `SerialBroker.restore()` sets up every remembered configuration.

What is remembered belongs to the origin, not to one tab. `release()` in one tab therefore forgets
a configuration only when no other tab still runs it with `persist: true`; otherwise the next
reload of those tabs would lose it. The same holds for `releaseAll()`, for
`release(name, { forgetDevice: true })` — which still revokes the permission for every tab — and
for a tab that sets the name up with `persist: false`. A tab that is closed, reloaded or crashes
forgets nothing, so the configuration is there on the next visit. Every tab running a remembered
configuration holds a shared Web Lock, `serial-broker/persisted/v2/<name>`, and the browser lets it
go when the tab goes away, however it goes.

Each configuration is stored under a key of its own,
`serial-broker/configurations/v2/entry/<name>`, listed in `serial-broker/configurations/v2/index`,
so two tabs remembering different configurations at the same moment cannot overwrite each other's.
An entry that cannot be read is discarded on its own and reported as `STORAGE_CORRUPT`; the other
configurations are restored regardless. What a release before this one stored is not read: its keys
are removed on the first `restore()`, and those configurations have to be set up once more.

Only the tab that holds the port can ask the user for permission, because only it can open the
port the user chooses. `requestAccess()` in any other tab rejects with `PERMISSION_REQUIRED` unless
the status is `open`, and returns `true` without asking once the port is open.

A USB vendor and product ID name a kind of device, not a particular one. With two identical
adapters granted, serial-broker uses the first one and says so in the log. A configuration with
`device: { any: true }`, for ports that have no USB identity at all, cannot tell ports apart
either.

## Limiting how many tabs use a port

By default every tab that sets a configuration up uses it. With `maxTabs`, at most that many do
at the same time, the tab holding the port included; `maxTabs: 1` gives one tab exclusive use.

```ts
await SerialBroker.setup('Press', {
  device: { vendorId: 0x0403, productId: 0x6001 },
  serial: { baudRate: 115_200 },
  maxTabs: 1,
});
```

A tab beyond the limit shows the status `queued`. It receives nothing, and a write it issues waits
for its deadline. When a tab releases the configuration, is closed or crashes, the tab that has
waited longest takes its place and goes on exactly like a tab that was never queued — becoming the
tab holding the port, if that place is free. The places are Web Locks, so the browser frees a
crashed tab's place as it frees ownership, and no timeout is involved.

Every tab has to pass the same limit. A tab that finds the tab holding the port running a different
one reports `CONFIGURATION_CONFLICT` to every tab, withdraws, and shows `failed` until it is
released and set up again with the same limit. Only tabs of this origin are counted: another
program or site holding the port makes opening it wait, but does not take a place.

## The message bus

Tabs exchange messages through a `SharedWorker` by default. The worker only routes messages: it
does not open the port, decide who owns it, or hold writes. If a `SharedWorker` is not available,
the browser refuses to create one, or its script fails to load, serial-broker uses a
`BroadcastChannel` instead. What a tab sent before its worker script failed is sent again over the
channel, once and in order, so the tab joins the others as if it had started there.

Behaviour is identical on both. The fallback costs a little more work per message, because every
tab receives every message and ignores those not meant for it; at the rates a serial device
produces, that is not measurable.

Every tab must load the worker from **the same URL**. Tabs that load it from different URLs are
connected to different workers, cannot see each other, and will compete for the device.

## Tabs running different versions

Tabs that run different versions of serial-broker's internal message protocol do not coordinate
with each other: they use different lock names and different workers, and each group behaves as if
it were alone. Each group has a tab trying to hold the device, and the group that comes second
cannot open it and keeps reconnecting.

They do notice each other. When a tab sets up its first configuration, it announces its protocol
version on a channel whose name no version changes, and it answers every announcement from another
version. A tab that learns of another version reports `PROTOCOL_VERSION_MISMATCH` through `onError`,
once per version. After deploying a version that changes the protocol, reload every open tab. The
changelog says when that is necessary.

## Fast devices and large writes

serial-broker keeps no buffer of its own between the port and your tabs. What that means at the
extremes:

**Reading.** The tab holding the port reads chunks as the browser hands them over — at most
`serial.bufferSize` bytes each — and sends every chunk to every tab as one message. Its own
`onReceive` listeners run before the next chunk is read, so a slow listener there slows reading
down; the browser's read buffer then fills, and a device without flow control loses what does not
fit. In the other tabs, messages that a busy tab cannot handle yet wait in the browser's queue for
that tab, which grows at the device's rate for as long as the tab lags. serial-broker cannot see
that queue or limit it. Keep `onReceive` listeners short, and hand heavy work to a later task. For a
device that sends quickly, a larger `bufferSize` means fewer, larger chunks and fewer messages.

**Text.** With `decodeText`, the tab holding the port decodes as it reads, with one decoder per
connection: a character split across two chunks arrives whole, however the chunks fall. A
character cut by a lost connection or a change of the tab holding the port is not.

**Writing.** One `send()` is one message to the tab holding the port, and one more to every tab
when it has been written, for `onSend`. A 50 MB payload is therefore copied into every tab of the
application, several times over while it is in flight. The tab holding the port hands it to the
device in chunks of `connection.maxWriteChunkBytes`, one at a time; each chunk has
`connection.writeTimeoutMs` to be accepted.

The whole `send()` has `connection.writeTimeoutMs` as well, in the tab that issued it. A write
that is still going when that deadline passes rejects with `WRITE_TIMEOUT` and `started: true`,
and goes on: its bytes keep reaching the device, and `onSend` reports it once it has finished. For
a large payload to a slow device, set `writeTimeoutMs` to cover it — up to ten minutes — or send
it as several `send()` calls where writes from other tabs may come in between.

Writes that wait behind a slow one each wait at most `connection.writeTimeoutMs`, and then leave
the queue, so the backlog at the tab holding the port never holds more than the writes issued in
that time.

## Tabs that run for a long time

A tab of an operator's screen may stay open for weeks. Browsers do several things to such a tab
that it is not told about in time, or not at all. serial-broker measures every wait with a timer,
never by comparing clock readings, except where this section says otherwise.

### Hidden tabs

A browser runs the timers of a hidden tab late: Chromium aligns them to whole seconds, and after five
minutes hidden, runs repeating timers only once a minute. Messages between tabs and device events
are not held back. In a hidden tab, deadlines, the one-second grace period after a crash and
reconnect delays can therefore end up to a minute late, and failover and write timeouts take that
much longer. The message bus counts unanswered heartbeats rather than measuring silence, so a
throttled tab is not mistaken for a dead worker.

A deadline that runs a second or more late first handles the messages that arrived meanwhile. A
write whose result is already waiting resolves instead of timing out, and a former holder's report
that is already waiting counts before its grace period ends.

### Frozen tabs

Chromium freezes hidden tabs to save energy: a frozen tab runs nothing until it is shown again.
It does not freeze a tab that uses Web Serial, or that holds a Web Lock another tab is waiting
for — so neither the tab holding the port, nor a tab holding a place that another tab queues for
under `maxTabs`, is frozen by that policy. Other tabs can be. A frozen tab hears nothing and sends
nothing; its own writes wait. Its message bus falls silent too, and the worker forgets it after
three minutes and takes it back with its next heartbeat. When it is shown again, its overdue timers
and the messages that arrived meanwhile run in no defined order; as for a hidden tab, a deadline
that is late handles the waiting messages first, so a write that succeeded meanwhile resolves.

### What serial-broker cannot know

A tab holding the port that stops running without going away — frozen by a browser whose policy
differs, paused in a debugger, or starved by a long task — keeps its lock, and so keeps the port.
No other tab can take over: the browser grants the lock only when that tab lets go or disappears.
Meanwhile the other tabs receive no data and no status change, and their writes reject with
`WRITE_TIMEOUT` and `started: false`. Nothing distinguishes such a tab from one whose device is
quiet. Taking the port from it would break the promise that only one tab writes to the device, so
serial-broker does not; when the tab runs again, it carries on where it stopped.

A tab that has let go of the port cannot wake up later with more to say about it: it sends its
goodbye, and reports every write it performed, before it releases the lock. What can arrive late is
what a crashed tab sent just before it crashed. The grace period for that is timed by the tabs
waiting for it, from when they hear of the new holder, so a waiting tab that was frozen itself does
not lose it. A report delayed on its way by more than a second remains undecidable, as described
under [A write that had started](#a-write-that-had-started-ends-with-owner_lost_during_write).

### Leaving the page, and discarded tabs

serial-broker listens for no page lifecycle events. In Chromium, a page that holds a Web Lock, uses
Web Serial or listens on a `BroadcastChannel` is not kept in the back/forward cache, and a tab with a
configuration set up does all three, so navigating away unloads it like closing it: the browser
closes its port and lets its locks go. Tabs on the `SharedWorker` are forgotten by the worker only
after three minutes. To say goodbye at once, and close the port before the lock is let go, call
`SerialBroker.dispose()` in a `pagehide` listener. Should a browser restore such a page from the
cache anyway — `pageshow` with `persisted` set — set its configurations up again.

A tab the browser discards to save memory is gone, as if it had crashed: its locks are let go and
another tab takes over. Chrome avoids discarding a tab connected to a device, but under memory
pressure any tab can be discarded. When the user returns to it, the page loads again, with
`document.wasDiscarded` set, and `restore()` brings its remembered configurations back.

### Sleep, and changes to the system clock

When a computer sleeps, every tab and the worker stop together, and when it wakes, their overdue
timers run. USB adapters are often reset on wake; the tab holding the port then reconnects as for
any unplugged device. The worker may run its check for silent tabs before their first heartbeat
after waking and forget them; each is taken back with its next heartbeat, within 15 seconds, and a
write that crosses the bus in between may be lost and rejects with `WRITE_TIMEOUT`.

The system clock can be set, or corrected, while tabs run — by the user, by a time zone change or by
an NTP step. Nothing this library times is affected. Every duration it measures — whether a
connection was stable (`connection.stableAfterMs`), how long a write has waited at the tab holding
the port, how late a deadline ran, how long a tab has been silent — is read from
`performance.now()`, the clock the timers themselves run on, which counts on regardless of the
system clock.

Timestamps are the other half: the `timestamp` of an error, the time of an event and the moments in
a diagnostics report are system-clock readings, so that they agree with the application's own logs.
They jump with the clock, and two tabs whose clocks differ stamp the same moment differently.

## What to watch out for

- Treat a received chunk as an arbitrary piece of the byte stream, never as a message.
- Keep `onReceive` listeners short, above all for a device that sends quickly.
- For large payloads to slow devices, set `connection.writeTimeoutMs` to cover the whole write.
- Decide, per command, whether it may be repeated after `OWNER_LOST_DURING_WRITE`.
- Do not assume an order between writes from different tabs.
- Assume data sent by the device during a handover may be lost.
- Call `requestAccess()` directly inside a click handler, in response to `awaiting-permission`.
- Serve the worker script from one URL, and set `workerUrl` before the first `setup()`.
- Use the same options for a configuration name in every tab. serial-broker does not compare them
  between tabs: the tab holding the port opens it with its own. See
  [Whose settings apply](configuration.md#whose-settings-apply).
- Pass the same `maxTabs` in every tab, and show `queued` to the user as waiting, not as an error.
- Handle status values you do not recognise gracefully: the list may grow.

[web-locks]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
