# Manual test plan

The automated suite simulates the browser. It is faithful, it is exhaustive, and it cannot
prove that this library works against a real Chromium and a real device — a fake that is wrong
in the same way the code is wrong passes every test.

**This plan must be worked through against real hardware before any release.** Record the
result in the pull request: browser version, operating system, device, and the outcome of each
step.

## Status

| | |
| --- | --- |
| **Last run** | *never — not yet run* |
| **Blocking for** | the first published release |

Everything below is written and ready to run; nothing in it has been executed yet. The
automated suite (423 tests) and the build are green, and the demo is served and parses, but no
part of this library has touched a physical serial port.

## Setup

1. `npm run build && npm run demo:build`
2. Serve the repository root over `http://localhost` — Web Serial refuses anything that is not
   a secure context, so a LAN address over plain HTTP will not do.
3. Open `http://localhost:<port>/examples/demo/` in Chrome.
4. Attach a USB-serial device. A CH340 adapter (`0x1a86` / `0x7523`) with its TX and RX pins
   bridged is ideal: everything sent comes straight back, so send and receive are visible in
   one window.

## Checklist

Each row corresponds to a row of the scenario matrix in
[testing.md](./guidelines/testing.md), which the automated suite covers in simulation.

### First connection

- [ ] **1.** Enter the device's IDs, click *Set up*. Status becomes `awaiting-permission` and
      *Choose device…* appears.
- [ ] **2.** Click *Choose device…*. Chrome shows its port picker, filtered to the configured
      device. Pick it: status becomes `open`.
- [ ] **3.** Send `HELLO`. With TX/RX bridged, both a `sent` and a `received` line appear.
- [ ] **4.** Reload the page. It reconnects **with no prompt** — the browser remembered the
      permission and the library remembered the configuration.

### Several tabs

- [ ] **5.** Open the demo in a second and third tab. Each reaches `open` without prompting.
- [ ] **6.** Send from tab 2. All three tabs log it: `sent` in tab 2, `sent (peer)` in the
      others. The device receives it **once**.
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
- [ ] **19.** Click *Release* with `forgetDevice` — verify the next `setup()` prompts again.
      (The demo's Release button does not pass it; test through the console.)

### Data

- [ ] **20.** Send a payload larger than 4 KB. It arrives complete and in order.
- [ ] **21.** Send non-ASCII text (`Grüße, 温度`). It round-trips correctly, including across a
      chunk boundary — send it repeatedly and quickly to make the split likely.
- [ ] **22.** Send binary through the console:
      `SerialBroker.send('DemoDevice', new Uint8Array([0x02, 0xff, 0x03]))`. The demo shows it
      as hex.

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
- [ ] **26.** If an Android device is available, open the demo on Chrome for Android with an
      OTG adapter. `SharedWorker` is absent there, so the fallback is what runs.

## Recording a run

Append to this file:

```
### 2026-??-?? — Chrome ???, Windows ??, CH340 loopback
Steps 1–26: pass / fail with notes.
Observations worth keeping.
```
