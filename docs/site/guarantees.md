# Guarantees

This chapter is the one place where serial-broker's promises are stated. Every other chapter links
here instead of repeating them. What is not written here is not promised.

## At a glance

| Promise                                                                           | Holds                             | Section                                                   |
| --------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| Exactly one tab has the port open at a time.                                      | Always.                           | [Failover](#failover)                                     |
| A resolved `send()` means the browser took all its bytes for the port.            | Always. Receipt is not reported.  | [What a resolved send means](#what-a-resolved-send-means) |
| Writes from one tab reach the port in the order that tab issued them.             | Always.                           | [Order](#order-and-interleaving)                          |
| The bytes of one `send()` are never interleaved with another's.                   | Always.                           | [Order](#order-and-interleaving)                          |
| Writes from different tabs have a defined order.                                  | **Not promised.**                 | [Order](#order-and-interleaving)                          |
| A write reaches the device at most once, and is never repeated by the library.    | Always, with one crash exception. | [Write outcomes](#write-outcomes)                         |
| A write rejected with `started: false` is never written afterwards.               | Always.                           | [Write outcomes](#write-outcomes)                         |
| Another tab takes over when the tab holding the port goes away.                   | However it goes away.             | [Failover](#failover)                                     |
| Data the device sends while the port changes hands is delivered.                  | **Not promised.**                 | [Failover](#failover)                                     |
| The connection comes back when the device does.                                   | With `connection.autoReconnect`.  | [Reconnecting](#reconnecting)                             |
| Every tab that has set up a configuration receives the same data from the device. | Once the tab knows who holds it.  | [Receiving](#receiving)                                   |
| Nothing is queued without a bound.                                                | Always.                           | [Limits](#limits)                                         |

## What a resolved send means

`send()` resolves when the browser has taken every byte of the call for the port — into its
transmit buffer of `serial.bufferSize` bytes. It does not mean the device has received the bytes,
let alone acted on them: Web Serial reports neither.

- A write that fits in that buffer resolves even while the device takes nothing, and reaches the
  device once it takes data again.
- A write that does not fit waits for the device. If the device does not take it within
  `connection.writeTimeoutMs`, the call rejects with `WRITE_TIMEOUT`; see
  [Write outcomes](#write-outcomes).
- A write that finds no open port waits for one, within the same `connection.writeTimeoutMs`.
- Nothing is appended to what is sent: no line ending, no terminator.

`onSend` reports the same moment, in every tab, for writes from every tab.

## Order and interleaving

- **Writes from one tab** reach the port in the order that tab issued them.
- **The bytes of one `send()`** are never interleaved with the bytes of another, from this tab or
  any other, even when a large payload is handed over in chunks of
  `connection.maxWriteChunkBytes`.
- **Writes from different tabs** have no defined order. If tab A and tab B send at the same time,
  either may reach the device first. A sequence of commands that must not be interrupted by another
  tab needs coordination in the application, such as a Web Lock of its own around the sequence;
  [Request and response across tabs](examples/advanced.md#request-and-response-across-tabs) shows
  one.

## Write outcomes

Every `send()` ends in one of these outcomes, in the tab that issued it.

| Outcome                                                                       | What was written                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Resolves                                                                      | Every byte, once, taken by the browser for the port.                                                                                                                                             |
| `WRITE_QUEUE_FULL`                                                            | Nothing, ever. It can be sent again.                                                                                                                                                             |
| `WRITE_TIMEOUT` with `started: false`                                         | Nothing, ever: a write that has waited `writeTimeoutMs` is not begun later. It can be sent again.                                                                                                |
| `WRITE_TIMEOUT` with `started: true`                                          | Begun. It goes on after the rejection, and `onSend` reports it once it has finished.                                                                                                             |
| `WRITE_TIMEOUT` with `bytesWritten` — the device did not take a chunk in time | `bytesWritten` of `byteLength` bytes. The rest is never sent. The connection stays open, the chunk stays in flight, and the writes behind it are not begun until the device takes it (ADR-0038). |
| `WRITE_FAILED`                                                                | `bytesWritten` of `byteLength` bytes. The tab holding the port reconnects.                                                                                                                       |
| The tab holding the port went away before it began the write                  | Nothing yet: the next tab to hold the port writes it, once.                                                                                                                                      |
| `OWNER_LOST_DURING_WRITE` — that tab went away after it began the write       | Unknown: some, all or none of the bytes. It is never sent again.                                                                                                                                 |

Repeating a write after `OWNER_LOST_DURING_WRITE` is the application's decision, because only it
knows whether a command is safe to repeat. A second "dispense", "cut" or "move 10 mm" is worse than
none. [Commands that must not run twice](examples/advanced.md#commands-that-must-not-run-twice)
shows how to decide.

**The one exception to at-most-once.** A tab that closes finishes the writes it began and reports
them before it lets go of the port. A tab that crashes reports nothing more, and a write it had
begun is rejected with `OWNER_LOST_DURING_WRITE` as soon as the browser frees its lock — unless it
crashed in the moment between handing the bytes to the device and its report that it had begun
reaching the tab that issued the write. From outside, such a tab looks exactly like one that never
received the write, so the write is handed to the next tab holding the port and may reach the device
twice. No library can decide this case; a protocol that must never execute a command twice needs a
request identifier the device checks.

A write issued by the tab holding the port itself is lost with that tab when it crashes: there is no
one left to report to.

## Failover

The tab holding a port holds a Web Lock for it. The browser releases that lock whenever the tab goes
away — closed, reloaded, crashed, killed from the task manager, discarded — and grants it to the tab
that has waited longest. That tab opens the port with its settings and carries on. In the other tabs
the status passes through `reconnecting` or `connecting` and returns to `open`. No timeout is
involved.

During a handover:

- **Data the device sends is lost** from the moment the old tab's port closes until the new tab has
  opened it — usually well under a second. So are bytes the old tab had collected but not yet
  delivered when it crashed. This is a property of the platform. If the device sends unsolicited
  data that must not be missed, have the protocol acknowledge it.
- **Writes that had not begun** are written by the new tab, once. Nothing waits for a timeout: a
  closing tab hands them over with its goodbye, a crashed one as the browser frees its lock.
- **Writes that had begun** end as described in [Write outcomes](#write-outcomes).
- **A text character** split across the handover is not decoded whole.

A tab holding the port that stops running without going away — paused in a debugger, frozen by a
browser policy — keeps its lock and so keeps the port; see
[What serial-broker cannot know](shared-ports.md#what-serial-broker-cannot-know).

## Reconnecting

The tab holding the port treats every way of losing the connection alike: a device unplugged or
switched off, a read or write that fails, a stream that ends, an `open()` that does not complete.
The status becomes `reconnecting` in every tab, and with `connection.autoReconnect` (the default)
that tab tries again:

- The first retry is immediate. Later ones back off exponentially with jitter, as
  [Reconnecting](configuration.md#reconnecting) describes.
- When the browser reports the device plugged in again, the next attempt is made at once.
- The attempt counter starts again only after a connection has held for
  `connection.stableAfterMs`.
- While the device stays away, the status stays `reconnecting`, and every attempt that does not find
  it counts towards `connection.maxAttempts`.
- After `connection.maxAttempts` the status becomes `failed` and `RECONNECT_EXHAUSTED` is reported
  once.
- An attempt the browser refuses — `WEB_SERIAL_UNAVAILABLE`, serial access blocked by a permissions
  policy — is not repeated: the status becomes `failed` at once.
- A `failed` configuration tries again when the browser reports the device plugged in again.
- Only the port the tab holds counts. Unplugging another port the configuration also matches changes
  nothing.

When the port disappears without the browser reporting the device unplugged — the user revoked the
permission in the site settings, or `forgetDevice` did — the status becomes `awaiting-permission`
instead.

**With `connection.autoReconnect: false`**, a lost connection or a failed attempt ends in `failed`,
with its error reported, and nothing is tried again: not after a delay, and not when the device is
plugged in again. The errors reported for the loss carry `isRetryable: false`. Nor does a handover
connect it: when the tab holding a `failed` configuration closes or crashes, the tab that takes the
port over stays `failed`, and so does every other tab. Only a configuration still in
`awaiting-permission` — it never found its device — connects when the device appears; that is its
first connection, not a reconnect. A first attempt that fails, such as an `open()` the device
refuses, ends in `failed` like any other, and plugging the device in again does nothing. A page that
loads while no other tab runs the configuration knows nothing of the failure, and connects when it
sets the configuration up: that is the application asking.

**Starting a failed configuration again.** Calling `setup()` again with the same options starts a
`failed` configuration again, whatever made it fail and whichever tab calls it: a tab that does not
hold the port asks the tab that does. A configuration that is not `failed` is left alone. The one
exception is a tab that withdrew because the tab holding the port runs a different `maxTabs`: it
stays `failed` until it is released and set up again with the same limit.

A device that is switched off while its USB adapter stays plugged in does not lose the connection:
the port stays open and stops taking data. Writes then end as in [Write outcomes](#write-outcomes),
and everything carries on the moment the device takes data again.

## Receiving

The tab holding the port reads the device, collects what it reads, and delivers it as one
`onReceive` event in every tab that has set the configuration up. A delivery is made when

- the line has been quiet for `receive.idleMs`,
- `receive.maxWaitMs` have passed since its first byte,
- 64 KiB have been collected, or
- the connection ends, before its status changes.

With `receive.idleMs: 0`, every piece is delivered as it is read. Details and defaults are in
[`receive`](configuration.md#receive).

What every tab can rely on:

- **The same bytes, in the same deliveries, in every tab**, with `data` always present and `text`
  when `encoding.decodeText` is on. A character split across two reads is decoded whole.
- **Delivery boundaries carry no meaning.** There is no framing: a message can arrive in two
  deliveries when the device pauses inside it, and several messages can arrive in one.
- **A tab that has just joined** receives data from the moment it knows which tab holds the port.
  What arrives before that is dropped and logged once as `session.data-without-a-term`.
- **Only tabs that have set the configuration up receive anything**, and a tab that is `queued`
  receives nothing.

## Limits

| Limit                                                         | Value                                                | Beyond it                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| Writes waiting at the tab holding the port, all tabs together | 4096 writes, and 64 MiB of payload                   | `WRITE_QUEUE_FULL`; nothing of the write is written.                    |
| Payload of one `send()`                                       | 16 MiB                                               | `INVALID_ARGUMENT`, in every tab alike. Split the data across calls.    |
| Tabs using one configuration                                  | `maxTabs`, see [`maxTabs`](configuration.md#maxtabs) | The tab waits with the status `queued`.                                 |
| One `onReceive` delivery                                      | 64 KiB                                               | Delivered at once; the rest follows in the next delivery.               |
| Waiting time of a write                                       | `connection.writeTimeoutMs`                          | `WRITE_TIMEOUT`.                                                        |
| Errors kept for a tab with no `onError` listener yet          | 16                                                   | The oldest are dropped, logged once as `client.unheard-errors-dropped`. |

What these limits cost at the extremes — a fast device, a slow listener, a large payload — is
described in [Fast devices and large writes](shared-ports.md#fast-devices-and-large-writes).
