# Known limits

What serial-broker cannot do, on any browser, and what to do about it. Each limit follows from the
platform or from a promise the library keeps; none is waiting for a fix.

## Identical devices cannot be told apart

The platform exposes a USB vendor and product ID for a port, but no serial number. The IDs name a
kind of device, not a particular one: with two identical adapters granted, serial-broker uses the
first one it finds and logs `matcher.ambiguous`. A configuration with `device: { nonUsb: true }` or
`{ any: true }` cannot tell ports apart at all.

**What to do:** connect one device of each kind per machine where you can. Where you cannot, let
the user choose the port in the picker and keep the configurations apart by device kind; see
[`device`](configuration.md#device). serial-broker does not keep configurations apart either: a
`{ any: true }` configuration next to a USB one matches that USB device's port as well.

## Data sent during a handover is lost

When the tab holding the port goes away, the browser closes the port, and nothing reads it until the
next tab has opened it — usually well under a second. What the device sends in that gap, and what
the old tab had collected but not yet delivered when it crashed, reaches no tab. No library can
recover it.

**What to do:** if the device sends unsolicited data that must not be missed, have its protocol
acknowledge it. An answer lost this way can only be noticed by waiting for it with a timeout, as
[Request and response across tabs](examples/advanced.md#request-and-response-across-tabs) does.

## Writes from different tabs have no defined order

Writes from one tab are strictly ordered and never interleaved. Between tabs, whichever write
reaches the tab holding the port first is written first.

**What to do:** where a sequence of commands must not be interrupted by another tab, coordinate
across tabs in the application, for example with a Web Lock of its own; see
[Order and interleaving](guarantees.md#order-and-interleaving).

## Tabs on different versions do not share

Tabs that run different protocol versions of serial-broker do not coordinate: each group tries to
hold the device, and the second cannot open it and keeps reconnecting. They report
`PROTOCOL_VERSION_MISMATCH` to each other; see
[Tabs running different versions](shared-ports.md#tabs-running-different-versions).

**What to do:** reload every tab after deploying a version that changes the protocol, and serve the
worker script of the release the page ships.

## A tab that stops running keeps the port

A tab holding the port that is paused in a debugger, frozen, or blocked by a long task keeps its Web
Lock, and no other tab can take over until it runs again or goes away. Meanwhile the other tabs'
writes fail with `WRITE_TIMEOUT`. See
[What serial-broker cannot know](shared-ports.md#what-serial-broker-cannot-know).

**What to do:** keep long work out of the tab's main thread, and do not leave a debugger paused on a
production screen.

## No tab can close the port for all the others

`release()`, `releaseAll()` and `dispose()` all act on the tab that calls them. If another tab still
has the configuration set up, the port stays open and ownership moves there - which is the point of
the library, and it means "the operator is finished, close the device" has no single call. A tab
cannot make the decision for tabs it is not allowed to see (ADR-0011).

**What to do:** have the application say so on its own bus - a `BroadcastChannel` message that every
tab answers by calling `release()` - or give the operator a screen where the last tab is closed.
`release(name, { forgetDevice: true })` does reach the whole origin, but it revokes the browser's
permission with it: the next `setup()` anywhere needs the picker again.

## A device that stops taking data keeps the port busy

A device switched off behind its powered USB adapter, or one holding back data with flow control,
leaves the port open. The status stays `open`, reads wait, and a write that does not fit the
browser's transmit buffer fails with `WRITE_TIMEOUT` while its chunk stays in flight: the browser
can neither withdraw it nor close the port while it is outstanding (ADR-0013). Writes carry on the
moment the device takes data again. Releasing the configuration during such a stall cannot close the
port either; the browser frees it only when the page goes away.

**What to do:** show `WRITE_TIMEOUT` while the status is `open` as "the device does not respond",
and check `flowControl`. The [diagnostics entry point](diagnostics.md#the-diagnostics-entry-point)
reports `stalledWriteSince` for such a write.

## A worker that hangs after answering is not noticed

The tabs learn that the `SharedWorker` has ended when the browser lets go of its Web Lock
(ADR-0041), at once and without a timer. A worker that keeps running but stops passing messages on -
a script stuck in a loop - still holds its lock, so no tab notices. Writes from tabs that do not hold
the port then end in `WRITE_TIMEOUT`, and what the device sends reaches only the tab holding the
port, until the page is reloaded. Only a worker that never answers when a tab connects is caught, by
the handshake deadline.

## Tabs on different message buses do not see each other

Tabs reach each other through the `SharedWorker` of their worker URL. A tab whose worker script did
not load — a transient network error, a page with a stricter content security policy — uses a
`BroadcastChannel` instead; tabs that name different worker URLs, or tabs left open across a deploy
that moved the URL, use different workers. Tabs on different buses exchange no messages. What rests
on Web Locks still holds, because the lock names depend on the configuration and the protocol
version, not on the bus:

- **Only one tab has the port open.** Tabs on every bus wait for the same ownership lock.
- **`maxTabs` counts every tab**, on whichever bus: the places are Web Locks as well.

What rests on messages does not:

- A tab on another bus than the tab holding the port receives nothing from the device, hears no
  status or error from that tab, and does not show `open`.
- Its writes never reach the tab holding the port. They wait, and reject with `WRITE_TIMEOUT` and
  `started: false`; nothing is written.
- When the tab holding the port goes away, whichever tab the browser grants the lock next opens the
  port, on its own bus. The tabs on the old holder's bus then show `reconnecting`, and their writes
  time out, until that tab goes away too.
- The [diagnostics entry point](diagnostics.md#the-diagnostics-entry-point) sees the tabs of its own
  bus only.

A tab that moved to a `BroadcastChannel` logs `environment.transport-fallback`; tabs on two workers
log nothing, and `chrome://inspect/#workers` lists both workers.

**What to do:** check a deployment as [After deploying](deploying.md#after-deploying) describes, fix
the cause, and reload the tabs on the wrong bus.

## Messages on their way when the bus changes are lost

When a tab moves to a new worker, or to a `BroadcastChannel` because the worker script failed, what
was on its way through the old bus is not repeated: data the device sent and status messages of that
moment reach no tab. Each tab restates its status on the new bus, and a write that had not started
is sent again once the port is reported `open` - it never reached the device, so this is not a
repeat.
