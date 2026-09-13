# ADR-0017: Emulate a USB serial device over USB/IP for testing without hardware

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

The automated suite simulates the browser. It cannot prove the library works against a real
Chromium and a real serial stack, which is why [the manual test plan](../manual-test-plan.md)
exists — and the plan needs a device. The cases it most needs to exercise are the ones hardware
produces worst: a device unplugged mid-write, a device that stops answering while its port stays
open, text split across chunk boundaries. A bench produces those by luck, not on command.

A virtual serial port would avoid the hardware, but on current Windows it cannot be had cheaply:

- **Every virtual COM port driver is a kernel driver.** Since the April 2026 Windows update,
  Windows 11 24H2 and later trust only kernel drivers signed through the Windows Hardware
  Compatibility Program; the cross-signed root program that com0com's builds use is no longer
  trusted, and this was confirmed on the development machine (Code Integrity event 3004 for
  `com0com.sys`, with Secure Boot, memory integrity and the vulnerable-driver blocklist on).
- **Chromium enumerates serial ports on Windows through `GUID_DEVINTERFACE_COMPORT` and the
  Ports and Modems setup classes**, reading the port name from the `PortName` registry value.
  A virtual driver has to register exactly that way to be visible at all.
- **A virtual COM port has no USB identity**, so it could only test `{ any: true }`
  configurations ([ADR-0016](./0016-non-usb-devices.md)), not the USB filter most applications
  use.

USB/IP sidesteps all three. It is a TCP protocol for attaching a USB device to a remote host;
[usbip-win2](https://github.com/vadimgrn/usbip-win2) is a Windows client for it whose drivers are
attestation-signed by Microsoft. A USB/IP server does not have to export real hardware: it can
answer the protocol itself. Windows then sees a USB device like any other.

## Decision

We ship a **USB/IP server in `emulator/` that exports an emulated USB CDC ACM device**, for use
with usbip-win2.

- The device declares class `0x02`, subclass `0x02` in its device descriptor, so Windows binds its
  inbox `usbser.sys` with no INF of ours, and it reports configurable vendor and product IDs,
  `0x1209:0x0001` by default (reserved by pid.codes for private testing).
- It is a loopback by default, matching the TX/RX-bridged adapter the manual plan assumes, and its
  failure modes are switchable at run time: unplug and plug, hang and resume, echo and silence,
  a cap on bytes per read, and unsolicited data.
- It is written in TypeScript and runs from source on the repository's own Node, with Node's type
  stripping; it has its own `tsconfig.json`, is linted and formatted with the rest of the
  repository, and is **not** part of the published package.
- Its tests run in the main Vitest run. They drive the server with a USB/IP client written
  independently of the server's encoder, so that a layout mistake cannot pass by being made
  identically on both sides.

## Alternatives considered

- **com0com.** The usual answer, and free. Its public builds are cross-signed and no longer load
  on Windows 11 24H2+ with default security; getting it to load means disabling Secure Boot,
  memory integrity or signature enforcement, which is not a reasonable price for a test. The
  "signature patch" downloads on unofficial sites are a worse risk than the test is worth.
- **A self-built UMDF virtual serial driver**, from Microsoft's `VirtualSerial2` sample. User-mode
  drivers are not subject to kernel code signing, and the sample registers
  `GUID_DEVINTERFACE_COMPORT` in the Ports class and echoes what is written. Plausible, and
  planned as a second path precisely because it has **no** USB identity and therefore exercises
  ADR-0016. Not the first path: it cannot test the USB filter, cannot hang mid-write without
  changing the sample, needs the WDK, and needs a self-signed certificate trusted machine-wide.
- **Commercial virtual serial port drivers.** Current signing status on Windows 11 24H2+ was not
  verifiable without buying them, they cost money per developer, and none injects failures.
- **A Linux VM with `tty0tty`.** Chromium on Linux ignores pseudo-terminals, so it would need a
  kernel module, a VM, and a desktop browser inside it — far more machinery than one Node program.
- **The `usbip` Rust crate's CDC ACM example.** Proves the approach, but adds a Rust toolchain to a
  Node repository and has no failure injection.
- **Real hardware only.** Remains mandatory before a release. Rejected as the _only_ way to test,
  because it cannot produce the failures on command.

## Consequences

### Positive

- The manual plan can be worked through on any Windows development machine, including the steps
  that need a device to be unplugged or to hang, and repeated as often as needed.
- The whole real software path is exercised: Web Serial, Chromium's port enumeration with USB IDs,
  `usbser.sys`, and the library.

### Negative

- A developer who uses it installs a third-party kernel driver (usbip-win2). It is open source and
  Microsoft-signed, but it is not Microsoft's; one release (0.9.7.8) carried a bug its author
  warned could cause a blue screen. The README pins the version.
- Timing is a loopback socket's, not a device's. Slowness must be produced with `hang` or `chunk`.
- It proves the software path, not the electrical one. It does not replace one run on real hardware
  before a release.

### Risks and mitigations

- **Unverified against the real client.** The server is tested against the protocol
  specification and an independent client, not yet against usbip-win2 itself. The emulator's
  README and the manual plan state this until the first run is recorded.

## Verification

`emulator/test/` — descriptors, the wire format at the specification's byte offsets, the device's
behaviour including unlink and hang, and the server over real TCP. The first run against
usbip-win2 is recorded in `docs/manual-test-plan.md`.
