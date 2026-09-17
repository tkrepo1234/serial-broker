# Manual test plan

The automated suite simulates the browser. It is faithful, it is exhaustive, and it cannot
prove that this library works against a real Chromium and a real device — a fake that is wrong
in the same way the code is wrong passes every test.

**This plan must be worked through against real hardware before any release.** Record the
result in the pull request: browser version, operating system, device, and the outcome of each
step.

## Status

|                          |                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------- |
| **Browser, no hardware** | **automated since 2026-09-14** (`test/browser/`, ADR-0035); before that by hand, see below               |
| **Emulated device**      | **first run 2026-09-15** — automated, `test/browser/hardware/emulator.spec.ts` via usbip-win2; see below |
| **With real hardware**   | **first run 2026-09-14** — automated, `test/browser/hardware/` against an Arduino; see below             |
| **Blocking for**         | the first published release                                                                              |

### 2026-09-12 — Edge 153.0.0.0, Windows 11 Home 26200, no device attached

What a browser can prove without a device was run and passed. The library was loaded from
`dist/`, served over `http://localhost`:

- **Platform requirements** — secure context, `navigator.serial`, `navigator.locks`,
  `SharedWorker` and `BroadcastChannel` all present; `isSupported()` agrees.
- **State machine** — `setup()` with no granted device walks `idle → connecting →
awaiting-permission` and stops there, as designed. No prompt is attempted.
- **Web Lock** — `navigator.locks.query()` shows exactly one exclusive holder of
  `serial-broker/owner/v1/<name>`. A second tab joins as one pending request, not a second
  holder.
- **Status propagation** — a second tab reaches `awaiting-permission` **without** passing
  through `connecting`: it took the status from the owner over the bus, which is the path
  added so the BroadcastChannel fallback behaves like the broker.
- **Persistence** — the configuration survives in `localStorage` and a new tab restores and
  reconnects to it unprompted.
- **Failover after an abrupt death** — the decisive one. A same-origin iframe took ownership,
  this tab queued behind it, and the iframe was then removed from the DOM: its context ceases
  to exist with no unload handler and no release. The lock moved to the waiting context
  immediately (`held: 1, pending: 0`, confirmed by an `ifAvailable` probe). This is ADR-0005
  working on the real platform rather than in simulation.
- **The broker** — a real `SharedWorker` was constructed from `dist/serial-broker.worker.js`,
  two ports attached, and a message from one was delivered to the other and **not** echoed
  back to its sender.
- **Console** — no errors, no unhandled rejections.

**Repeated 2026-09-13** against the build after the refactor in `dc934d0`, same browser:
the state machine, the single lock holder with one pending request, restoring from
`localStorage` and taking the status over the bus all behaved exactly as above, with no console
errors. Failover and the broker were not re-run; the refactor did not touch either.

What this run does **not** cover, and what the checklist below is still for: opening a port,
reading, writing, chunking, text decoding across chunk boundaries, unplugging a device
mid-write, and everything that needs a device to answer.

## Testing without hardware: what does not work

**com0com was tried on 2026-09-12 and does not work on current Windows 11.** Recorded here so
nobody spends the afternoon finding out again.

The signed build (`com0com-3.0.0.0-i386-and-x64-signed.zip` from SourceForge) installs
cleanly, and `setupc.exe install PortName=COM31 PortName=COM32` reports success — but the
device then sits at `ConfigManagerErrorCode 52`: _Windows cannot verify the digital signature
for the drivers required for this device._ No COM ports appear.

The reason is in the certificate: it was issued in 2016 (CyberCircuits, via Comodo) and
expired in 2018. Since Windows 10 1607, x64 kernel drivers must be attestation-signed through
the Hardware Dev Center; the exception covers drivers cross-signed **before July 2015**, which
this is not. The signature is valid — it is simply not the kind of signature Windows will load.

Tested on: Windows 11 Home, build 26200. Uninstalled completely afterwards; nothing was left
behind.

**Update 2026-09-13: no public com0com build can be expected to load any more.** The April 2026
Windows update removed default trust for every kernel driver signed through the cross-signed
root program, on Windows 11 24H2, 25H2 and 26H1 and all later versions; Microsoft keeps only an
explicit allow list of "a limited number of widely used" drivers. That covers the signed 2.2.2.0
build from 2011 as well — the one a SourceForge user reported working in September 2024, before
the change. Not tried here, because the result is foreseeable: this machine's Code Integrity log
shows the cross-certificate exceptions policy active on every boot, Secure Boot, memory
integrity and the vulnerable-driver blocklist all on, and `com0com.sys` rejected on 2026-09-12
(event 3004). Getting it to load would mean disabling Secure Boot, memory integrity or signature
enforcement, which is not a reasonable price for a test. Avoid third-party "signature patch"
downloads for it: an unofficial re-signed kernel driver is a far larger risk than the test is
worth.

**What to use instead:** a USB-serial adapter with its TX and RX pins bridged. The vendor
drivers (CH340, FTDI, CP2102) are WHQL-signed, there is no signature problem, and the test is
more honest anyway — only real hardware can be unplugged mid-write, which is the case this
library exists for.

If a virtual port is ever needed, the remaining candidates are commercial and would have to be
checked for a _current_ WHQL signature first: Virtual Serial Port Driver (Electronic Team),
HHD Virtual Serial Port Tools. Neither has been evaluated.

## Testing without hardware: the USB/IP emulator

`emulator/` contains an emulated USB serial device that usbip-win2 attaches to Windows, where it
appears as an ordinary USB serial device with a COM port. It is a loopback like the bridged
adapter below, and it can be unplugged, hung mid-write and made to split its answers on command,
which covers steps 13–17, 21 and 24 better than hardware can. Setup, commands and the mapping to
each step are in [`emulator/README.md`](../emulator/README.md); the reasoning is in
[ADR-0035](./adr/0035-browser-tests-with-playwright.md).

A run with the emulator is recorded like any other run, naming the emulator and the usbip-win2
version instead of a device. It does not replace the run on real hardware that a release needs:
it proves the software path, not the electrical one.

## Setup

1. `npm run debug` — builds the package and serves `dist/` over `http://localhost`. Web Serial
   refuses anything that is not a secure context, so a LAN address over plain HTTP will not do.
2. Open `http://localhost:<port>/debug/index.html` in Chrome — the debugging surface. Name the file:
   `/debug/` lists the directory, and `/debug` is one directory up from where the page lives, so
   the page's own `debug.css` would not be found. Its list shows every
   configuration; choosing one opens its detail view, which lists the tabs running it and which of
   them holds the port. Use it to confirm the failover steps rather than inferring them.
3. Attach a USB-serial device. A CH340 adapter (`0x1a86` / `0x7523`) with its TX and RX pins
   bridged is ideal: everything sent comes straight back, so send and receive are visible in
   one window.

## What the browser suite now does for you

`npm run test:browser` (ADR-0035) runs part of this plan on every CI run, and the hardware part of
that suite runs another part of it against a device — on Windows, because the permission it seeds
is a Windows device instance ID:

```sh
SERIAL_BROKER_HARDWARE=arduino npm run test:browser -- test/browser/hardware
```

```powershell
$env:SERIAL_BROKER_HARDWARE='arduino'; npm run test:browser -- test/browser/hardware
```

The 64 KiB round trip is no longer part of this suite: it took a quarter of an hour on the board,
and `emulator.spec.ts` covers it (steps 20, 22).

The emulator's suite runs the same way with `SERIAL_BROKER_HARDWARE=emulator` and
`test/browser/hardware/emulator.spec.ts`; it starts and drives the emulator itself.

What they cover of the checklist below, step by step:

| Step                             | Where it runs                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1 (the debugging surface)        | in a browser (`debug-surface.spec.ts`): the page creates a configuration and shows its detail      |
| 4a (choosing a device)           | Chromium's own picker answered through UI Automation, on the Arduino (`picker.spec.ts`)            |
| 2 (the port picker)              | a real click against the stand-in; Chromium's own picker on the Arduino (`picker.spec.ts`)         |
| 3, 5, 6                          | in a browser against the stand-in, on the Arduino and on the emulator                              |
| 4 (reload, no prompt)            | on the emulator: the reloaded page restores the configuration and opens the port                   |
| 7 (a tab in the background)      | a frozen tab in a browser; a hidden, throttled tab holding the port in `npm run test:background`   |
| 8 (one `SharedWorker`)           | in a browser, counted in Chromium's target list                                                    |
| 9                                | in a browser against the stand-in, on the Arduino and on the emulator                              |
| 10 (a killed tab)                | in a browser, the renderer killed over CDP - the same path as the task manager's _End process_     |
| 11, 12                           | on the emulator: handed on until one tab is left, then a new tab after the last                    |
| 13–15                            | in a browser against the stand-in, and on the emulator (`unplug`, `plug`)                          |
| 16 (backoff while unplugged)     | on the emulator: the delays grow to the cap, and plugging in cuts the wait short                   |
| 17 (a device that takes nothing) | on the emulator (`hang`): a short write resolves, a long one fails with `WRITE_TIMEOUT`, port open |
| 18 (permission revoked)          | **by hand**, in the site settings                                                                  |
| 19 (forget the device)           | on the emulator: after `release(name, { forgetDevice: true })` the status is `awaiting-permission` |
| 20                               | in a browser; 5 000 bytes on the Arduino; 65 536 bytes of every value on the emulator              |
| 21                               | in a browser (reads of 8 bytes) and on the emulator (`chunk 1`, one byte per read)                 |
| 22 (hex in the send box)         | the bytes on the emulator; the debugging surface's hex box and display in `debug-surface.spec.ts`  |
| 23 (no payload in the log)       | in-process (`test/integration/diagnostics.test.ts`)                                                |
| 24                               | on the emulator: the holder crashed while the device holds the write                               |
| 25                               | in a browser, repeating 5, 6, 9 and 13 over the fallback                                           |
| 26 (Chrome for Android)          | **by hand**, with a device and an OTG adapter                                                      |
| 27 (worker script answers 404)   | in-process (`test/integration/multi-tab/worker-script-fallback.test.ts`)                           |
| 28                               | in a browser                                                                                       |
| 29                               | in a browser: the worker terminated, each tab reporting once, and a tab frozen throughout it       |

So a release run by hand comes down to step 18 - the browser's settings offer nothing a test can
hold on to - and step 26, plus unplugging a physical adapter (13–16) once, since the emulator proves
the software path and not the electrical one. Two of the runs above need a desktop, because they
show a browser window, and are opt-in like the hardware suites:

```sh
SERIAL_BROKER_HARDWARE=picker npm run test:browser -- test/browser/hardware/picker.spec.ts
npm run test:background
```

## Checklist

The checklist exercises on real hardware what the scenario matrix in
[testing.md](./guidelines/testing.md) covers in simulation.

### First connection

Steps 1 and the `awaiting-permission` half of 2 were confirmed in the 2026-09-12 browser run;
they are left unticked because the checklist is about a run **with** hardware.

- [ ] **1.** Click _New configuration_, enter the device's IDs, click _Create and connect_. Its detail
      view shows `awaiting-permission` and _Choose device…_.
- [ ] **2.** Click _Choose device…_. Chrome shows its port picker, filtered to the configured
      device. Pick it: status becomes `open`.
- [ ] **3.** Send `HELLO`. With TX/RX bridged, both a `sent` and a `received` line appear.
- [ ] **4.** Reload the page. It reconnects **with no prompt** — the browser remembered the
      permission and the library remembered the configuration.
- [ ] **4a.** The same connection the other way round, on a browser that has not been given the
      device: click _Choose a device…_. The dialog opens first, with a free name and 9600 baud and
      no device to fill in. _Connect_ opens Chrome's port picker; dismiss it once: nothing is set
      up, and no error is shown. Click _Choose a device…_ and _Connect_ again and pick the port: the
      configuration takes its device from the port and reaches `open` **without a second prompt**.

### Several tabs

- [ ] **5.** Open the debugging surface in a second and third tab, choose the configuration in the
      list and click _Connect_ in its detail view. Each reaches `open` without prompting.
- [ ] **6.** Send from tab 2. Every tab's traffic shows it once, from tab 2. The device receives
      it **once**.
- [ ] **7.** Send from tab 3 while tab 1 is in the background. It still works.
- [ ] **8.** Check Chrome's task manager: exactly one `SharedWorker` for the origin.

### Failover

- [ ] **9.** Close the tab that was opened first. The others stay `open` or briefly show
      `reconnecting` or `connecting`, then `open`. Sending still works.
- [ ] **10.** Kill a tab from Chrome's task manager (right-click → End process) rather than
      closing it. Same result: this is the crash path, with no unload handler.
- [ ] **11.** Repeat until one tab is left. It takes over each time.
- [ ] **12.** Close the last tab, then open a new one. It connects with no prompt.

### Reconnection

- [ ] **13.** Unplug the device. Every tab shows `reconnecting` within a second.
- [ ] **14.** Plug it back in. Every tab returns to `open` **immediately**, not after the
      backoff delay — the `connect` event short-circuits the timer.
- [ ] **15.** Send after replugging. It works, with no application action in between.
- [ ] **16.** Unplug and leave it out for two minutes. Retries slow to roughly one every 30
      seconds; the console (with a logger configured) shows the backoff growing.
- [ ] **17.** Power the device off without unplugging the adapter, if the hardware allows it.
      The port stays open and the read loop stalls. A short write still resolves — the browser
      buffers `serial.bufferSize` bytes — but a write larger than that fails with
      `WRITE_TIMEOUT`, the status stays `open`, and once the device is back sending works
      again with no reload (ADR-0013).

### Permission changes

- [ ] **18.** Revoke the device in Chrome's site settings while connected. The tabs report the
      loss; after a reload the status is `awaiting-permission` again.
- [ ] **19.** Choose _Disconnect and forget device_ from the configuration's ⋯ menu — verify the next
      setup prompts again.

### Data

- [ ] **20.** Send a payload larger than 4 KB. It arrives complete and in order.
- [ ] **21.** Send non-ASCII text (`Grüße, 温度`). It round-trips correctly, including across a
      chunk boundary — send it repeatedly and quickly to make the split likely.
- [ ] **22.** Send `02 FF 03` with the send box set to _hex_. The traffic shows it as hex.

### Diagnostics

- [ ] **23.** With a logger configured, confirm that no `info` or `warn` record contains
      payload bytes.
- [ ] **24.** Provoke `OWNER_LOST_DURING_WRITE`: start a large write in one tab and kill that
      tab immediately. The originating tab is gone, so do it the other way round — write from
      tab B while tab A owns the port, and kill tab A mid-write. Tab B's promise must reject
      with that code and the bytes must **not** be re-sent.

### The fallback transport

- [ ] **25.** Force it with `SerialBroker.configure({ transport: 'broadcastchannel' })` before
      `setup()`, then repeat steps 5, 6, 9 and 13. Behaviour must be indistinguishable.
- [ ] **26.** If an Android device is available, open the debugging surface on Chrome for Android
      with an OTG adapter. `SharedWorker` is absent there, so the fallback is what runs.
- [ ] **27.** Configure a `workerUrl` that answers 404, open two tabs and set the configuration up
      in both, then repeat steps 5 and 6. Both tabs must log `environment.transport-fallback` with
      `reason: 'worker-script-failed'` and behave as in step 25.

### The worker

- [ ] **28.** Configure a `workerUrl` that serves a build of the worker with another
      `PROTOCOL_VERSION`, open two tabs and set the configuration up in both. Both tabs must report
      `PROTOCOL_VERSION_MISMATCH`, log `environment.transport-fallback` with
      `reason: 'worker-other-protocol-version'`, and behave as in step 25.
- [ ] **29.** With two tabs sharing the port, terminate the worker from `chrome://inspect/#workers`.
      As soon as the worker is gone each tab reports `BROKER_UNAVAILABLE` once, a new worker appears
      there, and steps 5 and 6 work again without a reload. Repeat with one tab hidden for more than
      five minutes beforehand: it reconnects as quickly — the worker's Web Lock is freed, and no
      timer waits (ADR-0041).

## Recording a run

Append to this file:

```
### 2026-??-?? — Chrome ???, Windows ??, CH340 loopback
Steps 1–29: pass / fail with notes.
Observations worth keeping.
```

### 2026-09-13 — Edge 153.0.0.0, Windows 11 Home 26200, no device: the debugging surface

The debugging surface from `dist/debug/`, served over `http://localhost`, on protocol version 2.
No device, so every configuration stays at `awaiting-permission`; what was checked is the
coordination and what the page shows of it.

- **Setting up from the page** reports `awaiting-permission` in _This tab_, with every
  `getStatus()` field, and the library's own log records in the event log.
- **The origin panel, through a real `SharedWorker`**, lists the tab as owner, marks it _this
  page_, and shows its connection state, attempt count and counters; _Web Locks_ shows
  `serial-broker/owner/v2/Device` held.
- **Observing does not participate.** A second tab that only collected saw the first tab as owner,
  and `navigator.locks.query()` showed one holder and **no** pending request. After it set the
  configuration up, it appeared as a participant, "held by another tab", and as one pending request.
- **Failover, seen from outside.** With the first tab closed, a fresh tab that only observed saw
  the remaining tab as the sole owner, holding the lock, with nothing pending.
- **Console:** no errors in any tab.

Not covered: anything that needs a device to answer, and the _Watch_ panel's ownership events
across the handover, because the tab that was watching was the one closed.

### 2026-09-14 — Edge 153.0.4234.32 (headless), Windows 11 Home 26200, Arduino on COM3: the first run against real hardware

The first time this library has moved bytes through a real UART. Run automatically, by
`test/browser/hardware/arduino.spec.ts` (ADR-0035), against the package built from the working
tree; the browser was driven by Playwright 1.63.0 and given the port through a throwaway profile
carrying the permission, so no prompt was answered and nothing on the machine was changed.

**Device:** an Arduino reporting USB `0x2341`/`0x0078`, device instance ID
`USB\VID_2341&PID_0078&MI_01\7&1B7B3EF0&0&0001`, on COM3, running an echo sketch. 9600 baud,
8N1, no flow control.

Six tests, all green:

- **A single tab** sets up, opens the port with no prompt, sends `HELLO` and receives it back.
- **Two tabs** share the port; a write from the second reaches the device **once** and both tabs
  see the one echo.
- **Three tabs** share it; the sender's `onSend` says `local`, the others' say `remote`.
- **Failover**: with three tabs attached, the tab holding the port is closed. Another tab takes
  the lock, reopens the real COM port, and the echo works again from a tab that never had it.
- **A payload larger than a write chunk** (5 000 bytes, chunked at 4 096) comes back byte for
  byte, across thousands of read boundaries.
- **Release and set up again** in the same tab: the browser kept the permission, so the second
  `setup()` opens the port with no prompt and the echo works again.

**64 KiB, run separately** (`SERIAL_BROKER_HARDWARE_LARGE=1`): 65 536 bytes written in one
`send()`, chunked at 4 096 by the library, came back **complete and in order** - an unbroken run of
all 65 536 bytes of the pattern - in **14.0 minutes**. Nothing was lost, nothing was reordered, no
error was reported, and no write timed out.

Worth keeping, because it is the kind of thing only hardware shows:

- **This board echoes at about 80 bytes a second**, whatever the line rate says - 64 KiB takes a
  quarter of an hour rather than the two minutes 9600 baud suggests. Nothing in the library
  notices: the write is handed to the driver in milliseconds and the answers arrive in ordinary
  reads. But the board goes on echoing long after the browser has closed the port, so a later run
  starts with the tail of an earlier one on the line: 30 090 bytes were drained after one
  abandoned attempt before the device fell quiet.
- Consequently the assertions are about **what arrived** - a marker counted in the received text,
  a run of a seeded pattern - and never about how many bytes arrived by when. A payload carries a
  per-run seed so that an echo of an earlier run cannot be mistaken for this one's.
- No `SerialBrokerError` was reported in any tab, and no console errors.

Not covered by this run: unplugging the device (needs a hand), the port picker and site settings,
and anything the debugging surface shows.

### 2026-09-15 — Edge 153.0.4234.32 (headless), Windows 11 Home 26200, usbip-win2 0.9.8.0: the first run against the emulator

The USB/IP emulator (`emulator/`, ADR-0035) attached by usbip-win2 0.9.8.0: Windows bound
`usbser.sys` and named the port **COM4**, device instance ID `USB\VID_1209&PID_0001\EMULATOR-0001`
— stable across attaches, because the emulator reports a serial number. By hand first (`npm run
emulator`: attached, configured, 9600 8N1, COM4 in Device Manager), then automatically by
`test/browser/hardware/emulator.spec.ts`, which starts the emulator and drives it through its
terminal (ADR-0035). Browser and permission as in the Arduino run: Playwright 1.63.0, a
throwaway profile, no prompt answered.

Ten tests, all green, against the build containing ADR-0013:

- **Step 3** — one tab echoes `HELLO`.
- **Steps 5, 6** — two tabs share the port; a write from the second reaches the device **once**,
  counted at the device (8 bytes more in the emulator's `status`), and both tabs see one echo.
- **Step 9** — three tabs; the holder is closed, another reopens COM4 and the echo works again.
- **Steps 13–15** — `unplug`: both tabs `reconnecting`; `plug`: usbip-win2 attaches again, both
  tabs `open`, sending works with no application action.
- **Step 17, a short write** — with the device hung, a 15-byte write **resolves**, though the
  device took nothing: it is in the browser's 255-byte port buffer. It arrives once the device
  takes data again.
- **Step 17, a long write** — 4 096 bytes fail with `WRITE_TIMEOUT`; the status stays `open`, and
  after `resume` the same tab sends again.
- **Step 21** — `chunk 1`: `Grüße, 温度` twice, one byte per read, decoded intact.
- **Steps 20, 22** — 65 536 bytes of every byte value echoed in order, in about three seconds.
- **The platform itself** — with Web Serial alone and the device holding a write, `writer.abort()`
  stays pending; after `resume` the abort and `port.close()` still do not settle, and `port.open()`
  reports the port already open.
- **Step 24** — the device hung, a 1 034-byte write from tab B held at the device, tab A (the
  holder) crashed: B's `send()` rejects with `OWNER_LOST_DURING_WRITE`, B takes the port over, and
  after `resume` the device has received the bytes at most once.

**Found on the way, and fixed in the same change (ADR-0013):** before the fix the long write of
step 17 left the configuration reconnecting for ever. A probe with Web Serial alone showed why: with
a write outstanding at the device, `writer.abort()` and `port.close()` never settle and
`port.open()` fails with "The port is already open" — also after the device recovers — until the
page's context goes away. Left alone, the same write completes when the device takes data, and
close and reopen take milliseconds. The library now leaves such a write in flight instead of
tearing the connection down.

Not covered here: steps 1–2, 4, 4a and 18–19 (the picker and site settings), 10 (a tab killed from
the task manager), 16 (two minutes of backoff), 25–29 (their browser tests run against the
stand-in) and 26 (Android). Nor the electrical path: an emulated device proves the software stack,
not a UART.

### 2026-09-15, later — the same machine: receiving, reconnecting, the Arduino again

Against the build with ADR-0002 (received bytes collected until the line is quiet) and protocol
version 10, both hardware suites at once, each device on its own COM port.

- **Arduino on COM3, 7 tests green** (the 64 KiB round trip skipped as usual). New: writing
  `1234\r\n` to the echo sketch, which returns the bytes one at a time, now arrives as **one**
  `onReceive` event - before, it was six (Tim's report of 2026-09-15).
- **Emulator on COM4, 11 tests green**, among them the same check with `chunk 1`, where every read
  returns a single byte, and step 21 with `receive.idleMs: 0`, so that the decoder still has to join
  the pieces of a character.

### 2026-09-15, evening — the emulator suite extended to steps 4, 11, 12, 14, 16 and 19

Same machine, Edge 153.0.4234.32 (headless), usbip-win2 0.9.8.0, the emulator on COM4, against
protocol version 13. **15 tests green** in 1.7 minutes, four of them new:

- **Step 4** — the page is reloaded; `restore()` alone brings the configuration back and the port
  opens with no prompt, and the echo works.
- **Steps 11, 12** — three tabs; the tab holding the port is closed until one is left, each successor
  echoing; then the last is closed too, and a new tab restores the configuration and connects.
- **Steps 14, 16** — unplugged, the scheduled reconnect delays grow from 0 through 250 ms, 500 ms …
  until one reaches half the 30-second cap; plugged in during that wait, the tab is `open` again well
  before the wait would have ended.
- **Step 19** — after `release(name, { forgetDevice: true })` a new `setup()`, in the same tab and in
  another, stays at `awaiting-permission`: the browser no longer has the permission.

The stand-in browser suite passed alongside (9 tests).

### 2026-09-15, evening — the Arduino suite: the port busy outside the browser

Arduino on COM3, same machine and browser. **6 of 7 tests green, three runs alike**: every time, the
first test (`echoes what a single tab sends`) never reached `open`. Its tab's history showed eight
attempts, each `open-failed` with `DEVICE_DISCONNECTED`, while later tests in new browsers opened the
same port. A probe with Web Serial alone - no library - could not open COM3 either: 113 attempts over
a minute, each `NetworkError: Failed to open serial port`. So something outside the browser held the
port; an `adb.exe` of the Arduino tooling had been started on the machine shortly before. Not a
library defect. The emulator suite (15 tests) passed at the same time.

The hardware suites now write each tab's statuses, error codes and log records next to a failed
test's results, which is what told this apart.

### 2026-09-16 — the Arduino suite with the port free: the board drops payloads over about 240 bytes

The port was free again (the program that held it on 2026-09-15 was gone), and **5 of the 6 tests
passed**, the first one included. What failed was `echoes a payload larger than the write chunk`:
of 5 000 bytes sent, **137 bytes came back** in one run and **none** in a second, within 180 seconds
each. No error was reported and the status stayed `open` throughout - the library sent the bytes and
waited for an echo that never came.

Measured afterwards **with Web Serial alone, no library**, on the same port in the same browser:

| Sent  | Echoed back within 12-15 s |
| ----- | -------------------------- |
| 16    | 16                         |
| 32    | 32                         |
| 64    | 64                         |
| 65    | 65                         |
| 128   | 128                        |
| 200   | 200                        |
| 240   | 240                        |
| 255   | 0                          |
| 256   | 0                          |
| 300   | 0                          |
| 512   | 208                        |
| 5 000 | 0                          |

After every one of those failures the board echoed 16 bytes again at once. So the board - or the
sketch on it - loses what arrives faster than it reads, from roughly 255 bytes on, and there is no
flow control to stop the host. Nothing in the library is involved: the same happens without it.
The same board echoed 5 000 bytes on 2026-09-14 and 2026-09-15, so this is a state of the board, not
a property of the test.

**How to tell this apart next time:** run the size probe with Web Serial alone before suspecting the
library, and read the tab histories the suites write next to a failed test. A release needs this test
against a board that keeps up - a power cycle, a sketch that reads while it writes, or flow control.
The 64 KiB round trip on the emulator (steps 20, 22) covers large payloads in the meantime.

### 2026-09-17 — Edge 153.0.4234.32 (headless), Windows 11 Home 26200: every suite again, after the rename

All suites run on `109eb1f`, the first complete pass since the product took the name serial-broker
and the wire protocol and storage versions went back to 1:

| Suite                                | Result                |
| ------------------------------------ | --------------------- |
| `npm run verify`                     | passed                |
| `npm run test:browser` (stand-in)    | 17 passed             |
| `npm run test:examples`              | 29 passed             |
| Emulator, usbip-win2 0.9.8.0 on COM4 | **15 of 15 passed**   |
| Arduino echo board on COM3           | **5 of 6 passed**     |
| `npm run docs`, `npm run docs:links` | built, no broken link |

The Arduino test that failed is the one of 2026-09-16, `echoes a payload larger than the write
chunk`, and it failed the same way: the echo never completed within 180 seconds, no error, status
`open`. The board is unchanged since then, so this is still the board dropping payloads from about
255 bytes on, not the library; the emulator's 64 KiB round trip passed in the same session. It stays
on the list for the release: repeat it against a board that keeps up.

### 2026-09-17, later — steps 2, 4a, 7 and 22 taken off the list of what is done by hand

**The picker (steps 2, 4, 4a).** `picker.spec.ts`, Edge 153.0.4234.32 with a window, a profile that
had never been given the device, the Arduino on COM3. Chromium's picker is answered through Windows
UI Automation. With the device configured, the picker offered exactly one port, the board's; picked,
the status went to `open`, `HELLO` came back, and a reload reconnected with no picker. In auto mode
the unfiltered picker was dismissed once - `dismissed`, no error, still `awaiting-permission` - and
answered the second time: `open` without a second prompt, `HELLO` echoed. **2 of 2 passed.**

**A tab in the background (step 7).** `npm run test:background`: a browser driven over the DevTools
protocol alone, because Playwright keeps every page visible. The tab holding the port was hidden
behind two others and its 50 ms interval ticked 5 times in 5 s; after **330 s** hidden it did not tick
at all in 5 s. In both runs a write from the visible tab and one from the hidden tab each reached the
device once and their echoes reached all three tabs, the hidden tab kept the port, and no tab reported
an error. Against the stand-in, so it says nothing about what Chromium does to a hidden tab that
holds a real port - it exempts those from freezing, which only makes this the harsher case.

**Found on the way:** a fresh Edge profile installs the machine's extensions a few seconds in, and
at that moment Edge ended the origin's `SharedWorker` and started another. Every tab reported
`BROKER_UNAVAILABLE` once, logged `transport.broker-lost`, and carried on with the new worker -
step 29, met in the wild. The background run starts its browser with `--disable-extensions` so that
it measures step 7 and nothing else.

**Hex (step 22).** `debug-surface.spec.ts` types `02 FF 03` with the send box set to hex: the line
ending is greyed out, and the traffic shows `02 FF 03` for what was sent and for what came back.

**Still by hand: step 18.** Tried the same day: Edge's settings pages list the site's serial
permission as text without a control a test can address, and the address bar's page-info bubble
did not stay open when opened through UI Automation. Whether Chromium sends `disconnect` on a
revoked permission (ADR-0010) therefore remains assumed.
