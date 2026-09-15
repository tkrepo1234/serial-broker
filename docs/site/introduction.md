# Introduction

## Web Serial, and the one thing it cannot do

The [Web Serial API][web-serial] lets a web page talk to a serial device: a USB-serial adapter, a
card reader, a scale, a label printer, a microcontroller. The browser shows a picker, the user
chooses a port once, and from then on the page can open it, read from it and write to it.

What it cannot do is share. A serial port can be open in exactly one browsing context. Open it in a
second tab and the browser refuses with `InvalidStateError`. An application that runs in several
tabs — a dashboard next to a settings page, an operator screen with a maintenance view beside it —
has to decide which tab gets the device, and every other tab goes without.

serial-broker removes that limit for every tab of one origin:

- **One tab holds the port; every tab uses it.** Any tab can send, and every tab receives what the
  device sends.
- **Another tab takes over** when the tab holding the port closes — including when it crashes, runs
  out of memory or is killed, with no code of its own running.
- **The connection comes back** when the device is unplugged or switched off and returns, with the
  same settings and no application code.
- **The device is remembered.** After the user has chosen it once, later visits connect with no
  prompt.

The application never learns which tab holds the port, and has no need to. What it can rely on is
stated in [Guarantees](guarantees.md); how tabs share the port is described in
[How shared ports behave](shared-ports.md).

## Who it is for

serial-broker is built for industrial use: production interfaces where a browser-based application
on the shop floor, at a test station or in a control room talks to scales, scanners, label printers,
PLCs, measuring instruments and controllers over serial lines. Two things matter most there, and the
library is designed around them:

- **Simple installation.** One package and one worker script served next to the application — no
  native helper, no driver, no browser extension. Rolling out the application rolls out the serial
  access, on every workstation alike.
- **Predictable behaviour.** A crashing tab, an unplugged device, a worker the browser ends: each is
  handled without application code, and whatever cannot be handled is reported with a stable error
  code and a sentence saying what to do. Every promise, and every limit, is written down.

It serves a point-of-sale screen or a hobby project just as well; the trade-offs are made for a
production line.

## Features

| Feature                        | What it gives you                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| **Shared port**                | Every tab reads and writes. A write reaches the device at most once, with [one crash exception](guarantees.md#write-outcomes). |
| **Failover**                   | The port moves to another tab when the tab holding it goes away, however it goes away.                                         |
| **Reconnection**               | Bounded exponential backoff with jitter, cut short when the browser reports the device back; or none, if you say so.           |
| **Remembered devices**         | The browser keeps the permission; serial-broker keeps the configuration and the device the user chose.                         |
| **Received data, collected**   | What the device sends is delivered once the line is quiet, the same in every tab; text is decoded on request.                  |
| **Text and binary**            | Strings are sent as UTF-8, bytes pass through untouched.                                                                       |
| **Errors that say what to do** | One error type with a stable code, structured context and a remediation sentence, rebuilt faithfully in every tab.             |
| **Fallback message bus**       | Works without `SharedWorker`, over a `BroadcastChannel`, for instance under a strict content security policy.                  |
| **Diagnostics**                | A separate entry point and a debugging surface show which tab holds each port and what it is doing.                            |

## What it deliberately does not do

- **No framing.** serial-broker wraps the transport and nothing else. It collects what the device
  sends until the line is quiet, but a delivery is not a message: one message can arrive in two
  deliveries, and several in one. Delimiters, checksums and request–response correlation belong in a
  protocol layer built on top; the [advanced examples](examples/advanced.md) show one.
- **No access to the `SerialPort`.** One tab closing a port the others depend on would break every
  guarantee.
- **No exactly-once delivery.** A serial port acknowledges nothing, so no library can promise that a
  device received a write; see [Guarantees](guarantees.md).
- **No telling identical devices apart.** The platform offers no serial number; see
  [Known limits](known-limits.md).

## Getting help

Search the [error codes](errors.md) first: every error carries a remediation sentence that is
usually the answer. For a deployment that misbehaves, open the
[debugging surface](diagnostics.md#the-debugging-surface): it shows which tab holds each port, what
its connection is doing, and what every tab is waiting for. [Troubleshooting](diagnostics.md#troubleshooting)
lists the common symptoms.

## License

MIT. How changes are made is described in the repository's `CONTRIBUTING.md` and its engineering
guidelines; the reasons behind the design are recorded as ADRs, see [Internals](internals.md).

[web-serial]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
