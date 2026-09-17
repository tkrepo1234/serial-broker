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
[ADR-0021](../docs/adr/0021-browser-tests-with-playwright.md).

> **Status:** covered by its own tests (`emulator/test/`), which drive it with an independent
> USB/IP client, and **run against usbip-win2 0.9.8.0 on Windows 11**:
> `test/browser/hardware/emulator.spec.ts` drives it from a real browser
> (`SERIAL_BROKER_HARDWARE=emulator`). The run is recorded in
> [the manual test plan](../docs/manual-test-plan.md).

## One-time setup

1. Download the installer for **usbip-win2 0.9.8.0** from its
   [releases page](https://github.com/vadimgrn/usbip-win2/releases). Use this version or later:
   0.9.7.8 has a bug its author warns can cause a blue screen.
2. Run it as administrator. Its drivers are attestation-signed by Microsoft, so Secure Boot and
   memory integrity stay on and test signing is **not** needed. The installer offers a restore
   point; take it. It also restarts every USB 3.0 hub once, so do not run it during a call on a
   USB headset.

That is all on the Windows side. The emulator itself needs **Node 22.18 or newer** (23.6 or newer
on the 23 line), newer than the library's toolchain needs: it runs its TypeScript sources directly,
on the type stripping those versions switch on by default. `node emulator/launch.mjs` checks for
that and says so plainly on an older Node, where `node emulator/src/main.ts` stops with a bare
`ERR_UNKNOWN_FILE_EXTENSION`.

## Running it

```sh
npm run emulator
```

It listens on `127.0.0.1:3240` and runs `usbip.exe attach` for you. Within a few seconds Device
Manager shows **USB Serial Device (COMn)** under _Ports_, and Windows' notification sound plays.

In the debugging surface (`dist/debug/`), pick the _Emulated device (emulator/)_ preset in the
_Device_ list of _New configuration_ — or _Other USB device_, with:

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

| Command       | What the device does                                                                                                                                 |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unplug`      | Disappears, as if its cable were pulled. It refuses to be re-attached until `plug`.                                                                  |
| `plug`        | Comes back and is attached again.                                                                                                                    |
| `hang`        | Stops accepting data. Writes stay in flight — the port stays open, the host just waits.                                                              |
| `resume`      | Accepts the held writes in order, and everything after.                                                                                              |
| `echo`        | Returns every byte written. The default.                                                                                                             |
| `silent`      | Accepts writes and answers nothing.                                                                                                                  |
| `chunk <n>`   | Returns at most _n_ bytes per read, so text arrives split — `chunk 1` splits every character.                                                        |
| `chunk off`   | Fills each read as far as the host's buffer allows again.                                                                                            |
| `send <text>` | Sends bytes on its own initiative. Escapes: `\r` `\n` `\t` `\\` `\"` `\xHH`. Refused, and logged as not sent, while no host has the device attached. |
| `status`      | Shows line coding, DTR/RTS, byte counters, and whether it is hung.                                                                                   |
| `attach`      | Runs `usbip.exe attach` without changing anything else.                                                                                              |
| `detach`      | Runs `usbip.exe detach` for the port the emulator attached, while that attachment lasts.                                                             |
| `help`        | Lists these commands.                                                                                                                                |
| `quit`        | Stops the emulator, closing every connection.                                                                                                        |

Every transfer is logged, so you can see exactly which bytes reached the device and when.

## Which steps of the manual test plan it covers

| Steps                        | How                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1–12, 18–19, 23, 25          | As written: it behaves like the loopback adapter the plan assumes.                                                                               |
| 13–15 (unplug, replug)       | `unplug`, then `plug`.                                                                                                                           |
| 16 (backoff while unplugged) | `unplug` and wait; `plug` when done.                                                                                                             |
| 17 (powered off, port open)  | `hang`. A write that fits the port buffer still resolves; a larger one fails with a timeout, and the port works again after `resume` (ADR-0011). |
| 20 (large payload)           | As written.                                                                                                                                      |
| 21 (text across chunks)      | `chunk 1` first; every multi-byte character then arrives split.                                                                                  |
| 22 (binary)                  | As written; `send \x02\xff\x03` covers the receiving direction.                                                                                  |
| 24 (owner lost during write) | `hang`, write from tab B, kill tab A, then `resume`. The bytes must not repeat.                                                                  |
| 26–28                        | Not the device's: they concern the worker script and the worker.                                                                                 |

The run on real hardware is the Arduino suite's (`SERIAL_BROKER_HARDWARE=arduino`): an emulated
device proves the software path, not the electrical one.

## Limitations

- **Windows only**, because that is the client usbip-win2 provides. On Linux, `usbip attach`
  from the kernel's own tools works against the same server; that is untested.
- **Timing is not a real device's.** A USB/IP device answers at the speed of a loopback socket.
  Anything that depends on a device being _slow_ has to be produced with `hang` or `chunk`.
- **One host at a time.** A second attach is refused while the first is active.

## Removing it

Uninstall _USBip_ from Windows' app settings. Nothing else was installed.
