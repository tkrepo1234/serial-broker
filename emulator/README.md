# Emulated serial device

A USB serial device that exists only in software, for testing this library in a real browser
on a machine with no hardware attached.

It is a small USB/IP server. [usbip-win2](https://github.com/vadimgrn/usbip-win2) attaches it
to Windows, which then sees an ordinary USB CDC ACM device, binds its own `usbser.sys` driver,
and gives it a COM port. Chromium lists that port like any other, with a vendor and a product
ID, so the whole path is real except the device itself: Web Serial, the Windows serial stack,
the USB driver, and this library on top.

The device is a loopback by default — everything written comes straight back, as with a
USB-serial adapter whose TX and RX pins are bridged. Unlike an adapter, it can also be unplugged,
hung mid-write, and made to split its answers, on command, which is what testing this library
actually needs. Why this approach and not a virtual COM port driver is in
[ADR-0017](../docs/adr/0017-usbip-device-emulator.md).

> **Status:** built and covered by its own tests (`emulator/test/`), which drive it with an
> independent USB/IP client. **It has not yet been run against usbip-win2 on Windows.** The
> first run is recorded in [the manual test plan](../docs/manual-test-plan.md).

## One-time setup

1. Download the installer for **usbip-win2 0.9.8.0** from its
   [releases page](https://github.com/vadimgrn/usbip-win2/releases). Use this version or later:
   0.9.7.8 has a bug its author warns can cause a blue screen.
2. Run it as administrator. Its drivers are attestation-signed by Microsoft, so Secure Boot and
   memory integrity stay on and test signing is **not** needed. The installer offers a restore
   point; take it. It also restarts every USB 3.0 hub once, so do not run it during a call on a
   USB headset.

That is all. The emulator itself needs nothing but this repository's Node.

## Running it

```sh
npm run emulator
```

It listens on `127.0.0.1:3240` and runs `usbip.exe attach` for you. Within a few seconds Device
Manager shows **USB Serial Device (COMn)** under _Ports_, and Windows' notification sound plays.

In the debugging surface (`dist/debug/`), set it up with — or pick the _Emulated device_ preset:

| Field      | Value    |
| ---------- | -------- |
| Vendor ID  | `0x1209` |
| Product ID | `0x0001` |
| Baud rate  | anything |

`0x1209:0x0001` is reserved by [pid.codes](https://pid.codes/1209/0001/) for private testing, so
it cannot collide with a real product. Pass `--vendor-id` and `--product-id` to impersonate
something else.

Options: `npm run emulator -- --help`.

## Commands

Typed into the emulator's terminal while it runs.

| Command       | What the device does                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| `unplug`      | Disappears, as if its cable were pulled. It refuses to be re-attached until `plug`.           |
| `plug`        | Comes back and is attached again.                                                             |
| `hang`        | Stops accepting data. Writes stay in flight — the port stays open, the host just waits.       |
| `resume`      | Accepts the held writes in order, and everything after.                                       |
| `echo`        | Returns every byte written. The default.                                                      |
| `silent`      | Accepts writes and answers nothing.                                                           |
| `chunk <n>`   | Returns at most _n_ bytes per read, so text arrives split — `chunk 1` splits every character. |
| `send <text>` | Sends bytes on its own initiative. Escapes: `\r` `\n` `\t` `\\` `\xHH`.                       |
| `status`      | Shows line coding, DTR/RTS, byte counters, and whether it is hung.                            |
| `attach`      | Runs `usbip.exe attach` without changing anything else.                                       |
| `detach`      | Runs `usbip.exe detach` for the port the emulator attached.                                   |

Every transfer is logged, so you can see exactly which bytes reached the device and when.

## Which steps of the manual test plan it covers

| Steps                        | How                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------- |
| 1–12, 18–19, 23, 25          | As written: it behaves like the loopback adapter the plan assumes.              |
| 13–15 (unplug, replug)       | `unplug`, then `plug`.                                                          |
| 16 (backoff while unplugged) | `unplug` and wait; `plug` when done.                                            |
| 17 (powered off, port open)  | `hang`. Writes must fail with a timeout rather than succeed silently.           |
| 20 (large payload)           | As written.                                                                     |
| 21 (text across chunks)      | `chunk 1` first; every multi-byte character then arrives split.                 |
| 22 (binary)                  | As written; `send \x02\xff\x03` covers the receiving direction.                 |
| 24 (owner lost during write) | `hang`, write from tab B, kill tab A, then `resume`. The bytes must not repeat. |

Not covered: step 26, which needs an Android device. And the plan still has to be run on real
hardware once before a release: an emulated device proves the software path, not the electrical
one.

## Limitations

- **Windows only**, because that is the client usbip-win2 provides. On Linux, `usbip attach`
  from the kernel's own tools works against the same server, but nobody has tried it.
- **Timing is not a real device's.** A USB/IP device answers at the speed of a loopback socket.
  Anything that depends on a device being _slow_ has to be produced with `hang` or `chunk`.
- **One host at a time.** A second attach is refused while the first is active.

## Removing it

Uninstall _USBip_ from Windows' app settings. Nothing else was installed.
