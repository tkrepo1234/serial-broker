# Introduction

## Web Serial, and the one thing it cannot do

The [Web Serial API][web-serial] lets a web page talk to a serial device: a USB-serial adapter, a
card reader, a scale, a label printer, a microcontroller. The browser shows a picker, the user
chooses a port once, and from then on the page can open it, read from it and write to it.

What it cannot do is share. A serial port can be open in exactly one browsing context. Open it
in a second tab and the browser refuses with `InvalidStateError`. An application that runs in
several tabs — a dashboard next to a settings page, a point-of-sale screen with a back office
beside it — has to decide which tab gets the device, and every other tab goes without.

serial-broker removes that limit for every tab of one origin:

- **One tab holds the port; every tab uses it.** Any tab can send, and every tab receives what
  the device sends.
- **Another tab takes over** when the holding tab closes — including when it crashes, runs out
  of memory, or is killed, with no code of its own running.
- **The connection comes back** when the device is unplugged or powered off and returns, with
  the same settings and no application code.
- **The device is remembered.** After the user has chosen it once, later visits connect with no
  prompt.

The application never learns which tab holds the port, and has no need to. How that works, and
what it means for an application, is the subject of [How shared ports behave](shared-ports.md).

## Features

| Feature                        | What it gives you                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| **Shared port**                | Every tab reads and writes. Writes from any tab reach the device once.                                             |
| **Failover**                   | Ownership moves to another tab when the holding tab goes away, however it goes away.                               |
| **Reconnection**               | Bounded exponential backoff with jitter, cut short the moment the browser reports the device is back.              |
| **Remembered devices**         | The browser keeps the permission; serial-broker keeps the configuration.                                           |
| **Text and binary**            | Strings are sent as UTF-8, bytes pass through untouched; received text is decoded across chunk boundaries.         |
| **Errors that say what to do** | One error type with a stable code, structured context and a remediation sentence, rebuilt faithfully in every tab. |
| **Fallback transport**         | Works without `SharedWorker` — on Chrome for Android, or under a strict content security policy.                   |
| **Diagnostics**                | A separate entry point and a debugging surface show which tab holds each port and what it is doing.                |

## What it deliberately does not do

serial-broker wraps the transport and nothing else. It delivers byte chunks as they arrive, with
no framing: one message from the device can arrive in five chunks, and five in one. Delimiters,
checksums and request–response correlation belong in a protocol layer built on top. It also
never hands out the underlying `SerialPort`: one tab closing a port the others depend on would
break every guarantee this documentation describes.

## Requirements

- A Chromium-based browser — Chrome, Edge, Opera, Brave — version 89 or later. Firefox and
  Safari do not implement Web Serial.
- A **secure context**: HTTPS, or `localhost` during development.
- All tabs on the **same origin**. Tabs of different origins never share anything.

## Getting help

Search the [error codes](errors.md) first: every error carries a remediation sentence that is
usually the answer. For a deployment that misbehaves, open the [debugging surface](diagnostics.md):
it shows which tab holds each port, what its connection is doing, and what every tab is
waiting for.

## Contributing

The repository's `CONTRIBUTING.md` and its engineering guidelines describe how changes are made.
Architectural decisions and the reasons behind them are recorded as ADRs; see
[Internals](internals.md).

## License

MIT.

[web-serial]: https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API
