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
reached the device. serial-broker hands it to the new owner, and it is written exactly once.

### A write that had started ends with `OWNER_LOST_DURING_WRITE`

A write that the old owner had already begun handing to the device is different. Some, all or none
of its bytes may have reached the device, and nothing can tell which. serial-broker rejects the
promise with `OWNER_LOST_DURING_WRITE` and **does not send it again**.

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
- **After `connection.maxAttempts`** (unlimited by default) the status becomes `failed`, and the
  error `RECONNECT_EXHAUSTED` is reported once. A failed configuration comes back by itself when the
  device is plugged in again.

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

Only the tab that holds the port can ask the user for permission, because only it can open the
port the user chooses. `requestAccess()` in any other tab rejects with `PERMISSION_REQUIRED` while
the status is `awaiting-permission`, and returns `true` without asking once the port is open.

A USB vendor and product ID name a kind of device, not a particular one. With two identical
adapters granted, serial-broker uses the first one and says so in the log. A configuration with
`device: { any: true }`, for ports that have no USB identity at all, cannot tell ports apart
either.

## The message bus

Tabs exchange messages through a `SharedWorker` by default. The worker only routes messages: it
does not open the port, decide who owns it, or hold writes. If a `SharedWorker` is not available —
or when the browser refuses to create one — serial-broker uses a `BroadcastChannel` instead. A
worker that is created but whose script cannot be loaded is not replaced; it is reported as
`BROKER_UNAVAILABLE`, and the tab cannot coordinate until the script is served correctly.

Behaviour is identical on both. The fallback costs a little more work per message, because every
tab receives every message and ignores those not meant for it; at the rates a serial device
produces, that is not measurable.

Every tab must load the worker from **the same URL**. Tabs that load it from different URLs are
connected to different workers, cannot see each other, and will compete for the device.

## Tabs running different versions

Tabs that run different versions of serial-broker's internal message protocol do not coordinate
with each other: they use different lock names and different workers, and each group behaves as if
it were alone. Because they never exchange a message, they cannot notice each other either. What
shows is the consequence: each group has a tab trying to hold the device, and the group that comes
second cannot open it and keeps reconnecting. After deploying a version that changes the protocol,
reload every open tab. The changelog says when that is necessary.

## What to watch out for

- Treat a received chunk as an arbitrary piece of the byte stream, never as a message.
- Decide, per command, whether it may be repeated after `OWNER_LOST_DURING_WRITE`.
- Do not assume an order between writes from different tabs.
- Assume data sent by the device during a handover may be lost.
- Call `requestAccess()` directly inside a click handler, in response to `awaiting-permission`.
- Serve the worker script from one URL, and set `workerUrl` before the first `setup()`.
- Use the same options for a configuration name in every tab. serial-broker does not compare them
  between tabs: the tab holding the port opens it with its own. See
  [Whose settings apply](configuration.md#whose-settings-apply).
- Handle status values you do not recognise gracefully: the list may grow.

[web-locks]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
