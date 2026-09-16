# ADR-0035: Test the built package in a real browser, and against real hardware

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** maintainers

## Context

The test suite runs in Node against a simulated browser
([ADR-0014](./0014-dependency-injection-of-the-environment.md)). That is what makes the hard parts
testable at all: a dozen tabs in one process, a tab killed at a chosen instruction boundary, every
delay controlled. It is also the suite's one weakness — a fake that is wrong in the same way as the
code passes every test, and nothing in it ever loads the files that are published.

Four claims are outside its reach:

1. **The platform behaves as `test/harness/` says.** A Web Lock really is released when a renderer
   dies, a `SharedWorker` really is one instance per origin, `BroadcastChannel` really does not
   echo to the sender.
2. **The built package works.** `dist/index.js` finds `dist/serial-broker.worker.js` through
   `new URL(..., import.meta.url)`; `dist/index.min.js` coordinates with tabs running the readable
   build.
3. **Two tabs of one origin, in one browser, share one port.** The product claim, end to end.
4. **Real bytes go through a real serial stack.** Everything else is something we wrote.

Two constraints shape any answer. A browser only shows the serial port picker to a user, and a
test may not click a native permission dialogue — nor change a machine-wide setting or an
enterprise policy to get around that. And a real device is attached to one machine: CI has none.

A device is also needed to exercise the cases hardware produces worst - a device unplugged
mid-write, a device that stops answering while its port stays open - and a bench produces those by
luck, not on command. A virtual COM port cannot be had cheaply on current Windows: since April 2026,
Windows 11 24H2 and later load only kernel drivers signed through the Windows Hardware Compatibility
Program, so com0com's cross-signed builds no longer load (confirmed on the development machine), and
a virtual COM port has no USB identity anyway. USB/IP sidesteps both: it is a TCP protocol for
attaching a USB device to a host, [usbip-win2](https://github.com/vadimgrn/usbip-win2) is a Windows
client whose drivers are attestation-signed, and a USB/IP server may answer the protocol itself.

## Decision

**A browser suite.** `test/browser/` runs the **built** package in a real Chromium through
[Playwright](https://playwright.dev/) (pinned to an exact version), started with
`npm run test:browser`, which builds first. `config/playwright.config.ts` starts a small static server
(`test/browser/server.mjs`) that serves `dist/` and the test pages, and the tests drive ordinary
pages that `import` the library. Locally it drives the installed Microsoft Edge
(`channel: 'msedge'`); CI sets `SERIAL_BROKER_BROWSER_CHANNEL=chromium` and installs that browser in
a job of its own.

Web Serial is replaced in the page, not in the library: `page.addInitScript()` installs
`test/browser/stand-in/web-serial-stand-in.ts`, a `navigator.serial` whose permission is per origin,
whose device can be open in one page only (a Web Lock the browser releases when a page dies), and
whose device is a loopback that can also speak first. Everything else - worker, channel, locks,
streams - is the browser's own. How many `SharedWorker`s an origin has, and when one ends, are taken
from Chromium's target list over CDP, and the broker is terminated through it.

The browser suite stays **small and scenario-shaped**, with no coverage gates. Races are tested in
`test/integration/multi-tab/`, which produces an interleaving on purpose; a browser produces it by
luck, which is a flaky test.

**A USB/IP device emulator.** `emulator/` is a USB/IP server that exports an emulated USB CDC ACM
device (class `0x02`, subclass `0x02`, so Windows binds its inbox `usbser.sys`), reporting
configurable IDs, `0x1209:0x0001` by default, and a serial number. It is a loopback by default, and
its failure modes are switchable at run time: unplug and plug, hang and resume, echo and silence, a
cap on bytes per read, unsolicited data. It is TypeScript run from source on the repository's Node,
linted with the rest, and **not** published. Its tests run in the main Vitest run, against a USB/IP
client written independently of the server's encoder.

**Hardware targets.** `SERIAL_BROKER_HARDWARE=arduino` runs `test/browser/hardware/arduino.spec.ts`
against an Arduino echoing on a COM port; `SERIAL_BROKER_HARDWARE=emulator` runs
`test/browser/hardware/emulator.spec.ts` against the emulator attached by usbip-win2, starting it as
a child process and driving its failure modes on cue. Both are Windows-only and never run in CI. They
get the port through a throwaway browser profile whose `Preferences` grant the serial permission for
the test origin by the port's device instance ID (content setting `serial_chooser_data`, as Chromium
stores a grant), so no prompt is answered and no policy or registry key is touched. The 64 KiB round
trip on the Arduino needs `SERIAL_BROKER_HARDWARE_LARGE=1`. Runs are recorded in the manual test
plan, which stays for what cannot be automated.

## Alternatives considered

- **Keep checking all of this by hand.** It runs when someone remembers, takes half an hour, and its
  result is a paragraph rather than a red build.
- **WebDriver BiDi, or Selenium.** A script installed before the page's own scripts, a profile
  directory ours to write before launch, and killing a renderer on command are Playwright's;
  together they decided it.
- **A headless-browser unit runner (Karma, Web Test Runner).** Runs the _sources_, answering none of
  claim 2, and cannot stage several tabs and a `SharedWorker`.
- **Let the browser tests use the real device.** The permission needs a gesture, the device is on
  one machine, and 9600 baud makes every assertion slow. The hardware suites check the stand-in
  against reality instead.
- **Grant the permission with the enterprise policy `SerialAllowUsbDevicesForUrls`.** A machine-wide
  registry change made by a test run that outlives it. Refused.
- **com0com, or a commercial virtual COM port driver.** No longer loads on Windows 11 24H2+ with
  default security, or is unverifiable without buying it, costs per developer, and injects no
  failures.
- **A self-built UMDF virtual serial driver.** Plausible, and it would exercise ports without USB
  identity, but it cannot test the USB filter or hang mid-write without changing the sample, and
  needs the WDK and a machine-wide certificate.
- **A Linux VM with `tty0tty`, or the `usbip` Rust crate's example.** Far more machinery than one
  Node program, or a Rust toolchain with no failure injection.
- **Real hardware only.** Remains mandatory before a release, but cannot produce failures on command.

## Consequences

### Positive

- The published files are loaded, by a browser, on every CI run, and the harness's claims are
  checked against the platform - including a lock released by a dying renderer and a `SharedWorker`
  shared by tabs.
- The whole real software path - Web Serial, Chromium's port enumeration, `usbser.sys`, the library -
  runs against a device that can be unplugged or hung on cue. Its first run found what no simulation
  could: a write the device does not take cannot be withdrawn
  ([ADR-0013](./0013-write-ordering-and-delivery-semantics.md)).
- The stand-in lets example applications run the library with no device attached.

### Negative

- A second fake to keep true; the hardware suites are what check it.
- Playwright is a large development dependency, though it downloads no browser on install.
- The browser suite is not deterministic in the way the rest is; nothing in it is retried.
- Using the emulator means installing a third-party kernel driver (usbip-win2). It is open source
  and Microsoft-signed, but one release (0.9.7.8) carried a bug its author warned could cause a blue
  screen; the emulator's README pins the version.
- The emulator proves the software path, not the electrical one, and its timing is a socket's.

### Risks and mitigations

- **The test runner's transform rewrites what is serialised into the page.** The stand-in uses
  closures instead of `#private` fields, and says so.
- **Every script an automation runs carries transient activation**, so `USER_GESTURE_REQUIRED` stays
  with the in-process suite.
- **A seeded permission depends on how Chromium stores it.** A change makes the hardware tests find no
  port - visibly, not silently.
- **Hardware behaviour is the device's.** Assertions are about what arrived, and payloads carry a
  per-run seed.

## Verification

`test/browser/shared-port.spec.ts`, `failover.spec.ts` (the holder closes, its renderer is killed,
the broker is terminated), `transports.spec.ts`, `minified-entry.spec.ts` and
`device-lifecycle.spec.ts`; `test/browser/hardware/arduino.spec.ts` and `emulator.spec.ts`, first run
under usbip-win2 0.9.8.0 on 2026-09-15; `emulator/test/` - descriptors, the wire format at the
specification's byte offsets, unlink and hang, and the server over real TCP. Runs are recorded in
[the manual test plan](../manual-test-plan.md).

## History

- 2026-09-13: USB/IP device emulator for testing without hardware (ADR-0017).
- 2026-09-14: Accepted - browser suite and Arduino hardware tests.
- 2026-09-15: The emulator as a second hardware target, verified under usbip-win2. ADR-0017 folded
  in.
