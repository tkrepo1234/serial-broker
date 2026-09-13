# Manual test plan

The automated suite simulates the browser. It is faithful, it is exhaustive, and it cannot
prove that this library works against a real Chromium and a real device — a fake that is wrong
in the same way the code is wrong passes every test.

**This plan must be worked through against real hardware before any release.** Record the
result in the pull request: browser version, operating system, device, and the outcome of each
step.

## Status

|                          |                                                                              |
| ------------------------ | ---------------------------------------------------------------------------- |
| **Browser, no hardware** | **run 2026-09-12, repeated 2026-09-13 on Edge 153 / Windows 11** — see below |
| **Emulated device**      | built 2026-09-13 (`emulator/`), _never run against usbip-win2_               |
| **With real hardware**   | _never run_                                                                  |
| **Blocking for**         | the first published release                                                  |

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
[ADR-0017](./adr/0017-usbip-device-emulator.md).

A run with the emulator is recorded like any other run, naming the emulator and the usbip-win2
version instead of a device. It does not replace the run on real hardware that a release needs:
it proves the software path, not the electrical one.

## Setup

1. `npm run debug` — builds the package and serves `dist/` over `http://localhost`. Web Serial
   refuses anything that is not a secure context, so a LAN address over plain HTTP will not do.
2. Open `http://localhost:<port>/debug/` in Chrome — the debugging surface. Each card lists the
   tabs running a configuration and which of them holds the port; use it to confirm the failover
   steps rather than inferring them.
3. Attach a USB-serial device. A CH340 adapter (`0x1a86` / `0x7523`) with its TX and RX pins
   bridged is ideal: everything sent comes straight back, so send and receive are visible in
   one window.

## Checklist

The checklist exercises on real hardware what the scenario matrix in
[testing.md](./guidelines/testing.md) covers in simulation.

### First connection

Steps 1 and the `awaiting-permission` half of 2 were confirmed in the 2026-09-12 browser run;
they are left unticked because the checklist is about a run **with** hardware.

- [ ] **1.** Click _New configuration_, enter the device's IDs, click _Set up_. The card shows
      `awaiting-permission` and _Choose device…_.
- [ ] **2.** Click _Choose device…_. Chrome shows its port picker, filtered to the configured
      device. Pick it: status becomes `open`.
- [ ] **3.** Send `HELLO`. With TX/RX bridged, both a `sent` and a `received` line appear.
- [ ] **4.** Reload the page. It reconnects **with no prompt** — the browser remembered the
      permission and the library remembered the configuration.

### Several tabs

- [ ] **5.** Open the debugging surface in a second and third tab and click _Connect_ on the card.
      Each reaches `open` without prompting.
- [ ] **6.** Send from tab 2. Every tab's traffic shows it once, from tab 2. The device receives
      it **once**.
- [ ] **7.** Send from tab 3 while tab 1 is in the background. It still works.
- [ ] **8.** Check Chrome's task manager: exactly one `SharedWorker` for the origin.

### Failover

- [ ] **9.** Close the tab that was opened first. The others stay `open` or briefly show
      `connecting`, then `open`. Sending still works.
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
      The port stays open and the read loop stalls; verify that writing reports a failure
      rather than silently doing nothing.

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
      Within about a minute each tab reports `BROKER_UNAVAILABLE` once, a new worker appears there,
      and steps 5 and 6 work again without a reload. Repeat with one tab hidden for more than five
      minutes beforehand: it reconnects too, within about four minutes.

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
