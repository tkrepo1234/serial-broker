# ADR-0038: Leave a write the device has not taken in flight

- **Status:** Accepted
- **Date:** 2026-09-15
- **Deciders:** maintainers

## Context

Until this decision, a chunk the device did not accept within `connection.writeTimeoutMs` was
treated like any failed write: the caller got `WRITE_TIMEOUT`, and the tab holding the port tore the
connection down — cancel the reader, abort the writer, close the port — and reconnected. The
reasoning was that a connection whose write failed is suspect, and the next write would fail the
same way.

The first run against the USB/IP emulator (ADR-0017) attached by usbip-win2, in Microsoft Edge 153
on Windows 11, showed that this is the one thing that must not happen. With the device hung —
accepting nothing, its USB interface still enumerated, as a device that has locked up or is
applying flow control — a probe using Web Serial directly, without this library, measured:

1. `writer.write()` of 4 096 bytes stays pending; a write that fits in the port's transmit buffer
   (`serial.bufferSize`, 255 bytes by default) **resolves at once**, although the device took
   nothing.
2. `writer.abort()` rejects the pending write immediately but **never settles itself**: Chromium's
   transmit flush waits for the operating system's write to finish
   (`SerialPortImpl::Flush` keeps its callback while `IsWritePending()`), and `PurgeComm` does not
   end that write.
3. `port.close()` then never settles, and `port.open()` fails with `InvalidStateError: The port is
already open` — **also after the device takes data again**. Measured for 10 s after it recovered.
4. The port is freed only when the page's browser context goes away; the emulator then sees the
   transfers cancelled and DTR dropped.

The same device, with the write simply left alone: when it takes data again the pending write
resolves, the writes behind it follow, every byte arrives once, and an orderly close and a new open
take milliseconds.

So the teardown turned a device that pauses into a configuration that reconnects for ever and never
recovers in that tab — nor in any other, since the port stays held. The in-process suite could not
show it: its fake port lets an abort settle.

## Decision

**A chunk that outlives `writeTimeoutMs` at the device no longer ends the connection.**

- The caller's `send()` rejects at the deadline with `WRITE_TIMEOUT`, with `bytesWritten` of
  `byteLength` in the context, as before. The rest of that payload is never written.
- The chunk stays in flight, and it keeps its place at the head of the write queue: nothing queued
  behind it begins until the device has taken it. Those writes fail at their own deadline with
  `WRITE_TIMEOUT` and `started: false`, which already means they were never written and never will
  be (ADR-0013), so the application may send them again.
- The tab logs `supervisor.write-stalled` (warn, without payload bytes).
- When the device takes the chunk, the queue carries on, with no reconnection and no status change.
- When the chunk fails instead — the stream errors, the device is lost — that is a lost connection,
  handled as any failed write is: `WRITE_FAILED` and reconnection.

A write that the device rejects outright (`WRITE_FAILED`) still ends the connection: an errored
stream holds no write, so closing it works.

The documentation stops saying that a resolved `send()` means the bytes reached the device. It means
the browser took them for the port; how much that is depends on `serial.bufferSize`.

## Alternatives considered

- **Keep tearing down, with a longer close deadline.** The close does not complete late; it does not
  complete. No deadline helps.
- **Tear down, and tell the other tabs to take the port over.** The port is held by the browser
  process for the page whose close is stuck, so no other tab can open it either.
- **Reload or close the page holding the port.** It frees the port, but it is not a library's to do,
  and it would lose the application's state for a device that merely paused.
- **Abort without closing, and keep using the port.** The aborted writable stream cannot be written
  to again, and a new one exists only after a close.
- **Keep writing behind the stuck chunk.** Chromium would queue the bytes and deliver them when the
  device recovers - including writes whose callers were told `WRITE_TIMEOUT` long ago, with a
  command already sent again by the application. That breaks at-most-once delivery (ADR-0013).

## Consequences

### Positive

- A device that stops taking data and comes back is used again by the same tabs, without a reload.
- A write reported as not started is still never written, including across the device's recovery.

### Negative

- While a chunk is stuck, the status stays `open` and reads go on, but every write fails. An
  application that wants to show that has to watch for `WRITE_TIMEOUT`; no status says it.
- Releasing the configuration while a chunk is stuck still cannot close the port: the drain, the
  abort and the close each run into their deadlines, and the port stays held until the page goes.
  That is the platform's limit, now reached only on release rather than on every timeout.
- A `send()` that fits in `serial.bufferSize` resolves even when the device takes nothing. That was
  always so; it is now documented.

### Risks and mitigations

- **Measured with usbip-win2 and an emulated device, not with a physical one.** A physical device
  that stops taking data does what the emulator's `hang` does - it answers its bulk endpoint with
  NAK - but whether a USB-serial adapter's driver ends a pending write where `usbser.sys` does not
  is unknown. The decision holds either way: a write that does end, ends the stall.
- **Chromium may change the flush.** If a later Chromium lets an abort complete, leaving the chunk in
  flight is still correct; only the teardown it replaces would have become possible again. The
  emulator suite pins the measured behaviour, so such a change shows up there.

## Verification

- `test/integration/connection-regressions.test.ts`, "a device that stops taking writes": the
  timeout keeps the connection; nothing behind the stuck write begins, and writing carries on once
  the device takes it; a stuck write that fails later reconnects.
- `test/browser/hardware/emulator.spec.ts`, step 17 of the manual test plan, in a real browser
  against the emulator: a write that fits the buffer resolves while the device takes nothing, and
  a larger one fails with `WRITE_TIMEOUT`, after which the same tab sends again once the device
  answers.
- The same spec, with Web Serial alone: while the emulator holds a write, `writer.abort()` stays
  pending, and after the device takes data again the abort and `port.close()` still do not settle
  and `port.open()` reports the port already open. A browser that changes this fails that test.
