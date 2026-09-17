# Manual test plan

The in-process suite simulates the browser. It is faithful, it is exhaustive, and it cannot prove
that this library works against a real Chromium and a real device - a fake that is wrong in the same
way the code is wrong passes every test. This plan is what has to hold against the real thing.

Nearly all of it runs by itself: in a real browser against a Web Serial stand-in on every CI run,
and on this project's Windows machine against an Arduino echo board and a USB/IP device emulator.
**One step is left to do by hand before a release: step 18.** Record a run at the end of this file.

## The USB/IP emulator

`emulator/` contains an emulated USB serial device that usbip-win2 attaches to Windows, where it
appears as an ordinary USB serial device with a COM port. It is a loopback like the bridged
adapter below, and it can be unplugged, hung mid-write and made to split its answers on command,
which covers steps 13–17, 21 and 24 better than hardware can. Setup, commands and the mapping to
each step are in [`emulator/README.md`](../emulator/README.md); the reasoning is in
[ADR-0021](./adr/0021-browser-tests-with-playwright.md).

A run with the emulator is recorded like any other run, naming the emulator and the usbip-win2
version instead of a device. The run on real hardware is the Arduino suite's.

## Setup

1. `npm run debug` — builds the package and serves `dist/` over `http://localhost`. Web Serial
   refuses anything that is not a secure context, so a LAN address over plain HTTP will not do.
2. Open `http://localhost:<port>/debug/index.html` in Chrome — the debugging surface. Name the file:
   `/debug/` lists the directory, and `/debug` is one directory up from where the page lives, so
   the page's own `serial-broker-debug.css` would not be found. Its list shows every
   configuration; choosing one opens its detail view, which lists the tabs running it and which of
   them holds the port. Use it to confirm the failover steps rather than inferring them.
3. Attach a USB-serial device. A CH340 adapter (`0x1a86` / `0x7523`) with its TX and RX pins
   bridged is ideal: everything sent comes straight back, so send and receive are visible in
   one window.

## What the browser suite does for you

`npm run test:browser` (ADR-0021) runs part of this plan on every CI run, and the hardware part of
that suite runs another part of it against a device — on Windows, because the permission it seeds
is a Windows device instance ID:

```sh
SERIAL_BROKER_HARDWARE=arduino npm run test:browser -- test/browser/hardware
```

```powershell
$env:SERIAL_BROKER_HARDWARE='arduino'; npm run test:browser -- test/browser/hardware
```

The Arduino suite sends no large payload: the board echoes at about 80 bytes a second, and
`emulator.spec.ts` covers the 64 KiB round trip (steps 20, 22).

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
| 20                               | in a browser, and 65 536 bytes of every value on the emulator                                      |
| 21                               | in a browser (reads of 8 bytes) and on the emulator (`chunk 1`, one byte per read)                 |
| 22 (hex in the send box)         | the bytes on the emulator; the debugging surface's hex box and display in `debug-surface.spec.ts`  |
| 23 (no payload in the log)       | in-process (`test/integration/diagnostics.test.ts`)                                                |
| 24                               | on the emulator: the holder crashed while the device holds the write                               |
| 25                               | in a browser, repeating 5, 6, 9 and 13 over the fallback                                           |
| 26 (worker script answers 404)   | in-process (`test/integration/multi-tab/shared-worker.test.ts`)                                    |
| 27                               | in a browser                                                                                       |
| 28                               | in a browser: the worker terminated, each tab reporting once, and a tab frozen throughout it       |

So a release run by hand comes down to step 18: the browser's settings offer nothing a test can
hold on to. Unplugging (13–16) is the emulator's. Two of the runs above need a desktop, because
they show a browser window, and are opt-in like the hardware suites:

```sh
SERIAL_BROKER_HARDWARE=picker npm run test:browser -- test/browser/hardware/picker.spec.ts
npm run test:background
```

## Checklist

The checklist exercises on real hardware what the scenario matrix in
[testing.md](./guidelines/testing.md) covers in simulation.

### First connection

- [ ] **1.** Click _New configuration_, choose the device in the _Device_ list - a preset, or _Other
      USB device_ and its vendor and product ID - and click _Create and connect_. Its detail view
      shows `awaiting-permission` and _Choose device…_.
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
      again with no reload (ADR-0011).

### Permission changes

- [ ] **18.** Revoke the device in Chrome's site settings while connected. The tabs report the
      loss; after a reload the status is `awaiting-permission` again.
- [ ] **19.** Click _Disconnect…_, tick _Forget the device_ in the dialog and confirm — verify the
      next setup prompts again.

### Data

- [ ] **20.** Send a payload larger than 4 KB. It arrives complete and in order.
- [ ] **21.** Send non-ASCII text (`Grüße, 温度`). It round-trips correctly, including across a
      chunk boundary — send it repeatedly and quickly to make the split likely.
- [ ] **22.** Send `02 FF 03` with the send box set to _hex bytes_. The traffic shows it as hex.

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
- [ ] **26.** Configure a `workerUrl` that answers 404, open two tabs and set the configuration up
      in both, then repeat steps 5 and 6. Both tabs must log `environment.transport-fallback` with
      `reason: 'worker-script-failed'` and behave as in step 25.

### The worker

- [ ] **27.** Configure a `workerUrl` that serves a build of the worker with another
      `PROTOCOL_VERSION`, open two tabs and set the configuration up in both. Both tabs must report
      `PROTOCOL_VERSION_MISMATCH`, log `environment.transport-fallback` with
      `reason: 'worker-other-protocol-version'`, and behave as in step 25.
- [ ] **28.** With two tabs sharing the port, terminate the worker from `chrome://inspect/#workers`.
      As soon as the worker is gone each tab reports `BROKER_UNAVAILABLE` once, a new worker appears
      there, and steps 5 and 6 work again without a reload. Repeat with one tab hidden for more than
      five minutes beforehand: it reconnects as quickly — the worker's Web Lock is freed, and no
      timer waits (ADR-0024).

## The last run

**2026-09-17, Edge 153.0.4234.32, Windows 11 Home 26200**, on the commit released as
0.1.0-beta.1:

| Suite                                                       | Result           |
| ----------------------------------------------------------- | ---------------- |
| `npm run verify`                                            | passed           |
| `npm run test:browser` (stand-in)                           | passed           |
| `npm run test:examples`                                     | passed           |
| Emulator, usbip-win2 0.9.8.0 on COM4                        | 15 of 15 passed  |
| Arduino echo board on COM3                                  | 6 of 6 passed    |
| Chromium's own picker, on the Arduino (`picker.spec.ts`)    | 2 of 2 passed    |
| A tab in the background, 10 s and 330 s (`test:background`) | passed           |
| `npm run test:extreme`, both benchmarks                     | every bound held |
| Step 18, by hand                                            | **not run**      |

When a release is made, replace this section with that release's run: browser version, operating
system, devices, and the outcome of each suite and of step 18.

## Worth knowing before the next run

- **The Arduino board loses what arrives faster than its sketch reads**, from about 255 bytes on -
  measured with Web Serial alone, without the library. It has no flow control. Payloads beyond one
  write chunk are therefore the emulator's, which takes 64 KiB and counts what reached the device.
- **When the Arduino suite cannot open the port at all**, something outside the browser holds it.
  Check with Web Serial alone before suspecting the library; the suites write each tab's history
  next to a failed test.
- **A fresh browser profile installs the machine's extensions a few seconds in, and Edge ends the
  origin's `SharedWorker` when it does.** Every tab reports `BROKER_UNAVAILABLE` once, logs
  `transport.broker-lost`, and carries on with a new worker - step 28, met in the wild.
  `npm run test:background` starts its browser with `--disable-extensions` for that reason.
- **Step 18 resists automation.** Edge's settings pages list the site's serial permission as text
  without a control a test can address, and the address bar's page-info bubble does not stay open
  when opened through UI Automation.
- **Virtual COM port pairs do not work on current Windows.** com0com's driver is cross-signed, and
  Windows does not trust such kernel drivers; loading it would mean switching off Secure Boot or
  memory integrity, which is not a price for a test. The emulator over usbip-win2, whose driver is
  attestation-signed, stands in their place.
