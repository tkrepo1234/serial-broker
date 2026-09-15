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

## At-most-once has one exception

A tab holding the port that crashes in the moment between handing a write to the device and
reporting that it began can make that write reach the device twice. The case is described under
[Write outcomes](guarantees.md#write-outcomes).

**What to do:** for commands that must never run twice, give them an identifier the device checks.

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

## A device that stops taking data keeps the port busy

A device switched off behind its powered USB adapter, or one holding back data with flow control,
leaves the port open. The status stays `open`, reads wait, and a write that does not fit the
browser's transmit buffer fails with `WRITE_TIMEOUT` while its chunk stays in flight: the browser
can neither withdraw it nor close the port while it is outstanding (ADR-0038). Writes carry on the
moment the device takes data again. Releasing the configuration during such a stall cannot close the
port either; the browser frees it only when the page goes away.

**What to do:** show `WRITE_TIMEOUT` while the status is `open` as "the device does not respond",
and check `flowControl`. The [diagnostics entry point](diagnostics.md#the-diagnostics-entry-point)
reports `stalledWriteSince` for such a write.
