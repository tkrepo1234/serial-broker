# ADR-0035: Test the built package in a real browser, and against real hardware

- **Status:** Accepted
- **Date:** 2026-09-14
- **Deciders:** maintainers

## Context

The test suite runs in Node against a simulated browser (ADR-0014). That is what makes the hard
parts testable at all: a dozen tabs in one process, a tab killed at a chosen instruction boundary,
every delay controlled. It is also the suite's one weakness — a fake that is wrong in the same way
as the code passes every test, and nothing in it ever loads the files that are published.

Four claims are outside its reach:

1. **The platform behaves as `test/harness/` says.** A Web Lock really is released when a renderer
   dies, a `SharedWorker` really is one instance per origin, `BroadcastChannel` really does not
   echo to the sender.
2. **The built package works.** `dist/index.js` finds `dist/serial-broker.worker.js` through
   `new URL(..., import.meta.url)`; `dist/index.min.js` is the same library and coordinates with
   tabs running the readable build.
3. **Two tabs of one origin, in one browser, share one port.** The product claim, end to end.
4. **Real bytes go out of a real UART and come back.** Everything else is something we wrote:
   a simulated browser, a Web Serial stand-in, an emulated USB device (ADR-0017).

Before this decision, all four were checked by hand and written down in
[the manual test plan](../manual-test-plan.md). That is honest but it does not run in CI, and the
hardware half had never been run at all.

Two constraints shape any answer. A browser only shows the serial port picker to a user, and a
test may not click a native permission dialogue — nor may it change a machine-wide setting or an
enterprise policy to get around that. And a real device is attached to one machine: CI has none.

## Decision

A second suite, `test/browser/`, runs the **built** package in a real Chromium through
[Playwright](https://playwright.dev/) (pinned to an exact version), started with
`npm run test:browser`, which builds first. `playwright.config.ts` starts a small static server
(`test/browser/server.mjs`) that serves `dist/` and the test pages on a port of its own, and the
tests drive ordinary pages that `import` the library — never a dynamic `import()` inside an
evaluation.

Locally the suite drives **the installed Microsoft Edge** (`channel: 'msedge'`), so a contributor
downloads no browser; CI sets `SERIAL_BROKER_BROWSER_CHANNEL=chromium` and installs that browser
explicitly (`npx playwright install --with-deps chromium`) in a job of its own.

Web Serial is replaced in the page rather than in the library. `page.addInitScript()` installs
`test/browser/stand-in/web-serial-stand-in.ts` before the page's own scripts run: a
`navigator.serial` whose permission is per origin (kept in `localStorage`, which the pages of an
origin share), whose device can be open in one page only (enforced with a Web Lock, which the
browser releases when a page dies), and whose device is a loopback. Everything else in the page —
the worker, the channel, the locks, the streams — is the browser's own.

**The hardware tests run only when `SERIAL_BROKER_HARDWARE=arduino` is set**, and never in CI.
They get the port through a throwaway browser profile whose `Preferences` file was written before
the browser started, granting the serial permission for the test origin. That is where Chromium
keeps such a grant anyway: content setting `serial_chooser_data`, one object per port, and on
Windows that object is the port's **device instance ID** plus a display name
(`chrome/browser/serial/serial_chooser_context.cc`). No prompt is answered, no policy or registry
key is touched, and the profile is deleted with the run's artefacts.

The browser suite stays **small and scenario-shaped**. It has no coverage gates and it is not
where races are tested: an interleaving that a browser produces by luck is a flaky test, and
`test/integration/multi-tab/` produces the same interleaving on purpose. What belongs here is what
only a browser can answer.

## Alternatives considered

- **Keep checking all of this by hand.** It is written down, it is thorough, and it was done - but
  it runs when someone remembers, it takes half an hour, and its result is a paragraph in a file
  rather than a red build. The manual plan stays for what cannot be automated (the picker, a
  device unplugged by a hand, Chrome for Android).
- **WebDriver BiDi, or Selenium.** Standard, and driving Edge with it is no harder. But three
  things this suite depends on are Playwright's: a script installed before the page's own scripts
  run, a persistent context whose profile directory is ours to write before launch, and killing a
  renderer on command. Each is possible elsewhere with more machinery; together they decided it.
- **A headless-browser unit runner (Karma, Web Test Runner).** Runs the _sources_ in a browser,
  which answers none of claim 2 and only half of claim 1: several tabs and a `SharedWorker`
  handshake are outside what a test runner page can stage.
- **Playwright's bundled Chromium locally as well.** One more browser downloaded per machine, for
  a browser every developer already has. CI has neither, so it installs one and says so.
- **Let the browser tests use the real device.** The permission needs a gesture, the device is on
  one machine, and 9600 baud makes every assertion slow. The stand-in runs everywhere in
  milliseconds; the hardware suite then checks the stand-in itself against reality.
- **Grant the serial permission with the enterprise policy `SerialAllowUsbDevicesForUrls`.**
  Chromium supports exactly this, and it is the documented way. It is also a machine-wide registry
  change made by a test run, on a developer's own machine, that outlives the run. Refused; the
  profile that the browser throws away afterwards achieves the same thing for one browser launch.
- **Click the port picker.** It is a native dialogue, it is not automatable through the page, and
  teaching a test to answer permission prompts is the one habit this library must not encourage.
- **A second checkout, built with another `PROTOCOL_VERSION`, for the mismatch test.** The static
  server rewrites the constant in the built worker instead, and fails loudly if the assignment it
  looks for is not there any more.

## Consequences

### Positive

- The published files are loaded, by a browser, on every CI run: the worker URL, the minified
  entry point and the CommonJS-free ES module path cannot break unnoticed.
- The claims of `test/harness/` are checked against the platform, including the two that carry the
  most risk: a lock released by a dying renderer, and a `SharedWorker` shared by tabs.
- The library has been run against real hardware, and the result is recorded rather than claimed.
- The stand-in is written so that the example applications can install it too: a demo page can run
  the whole library with no device attached.

### Negative

- A second fake to keep true. It models less than `test/harness/fake-serial.ts` does - no fault
  injection, no queued picker - and what it models it models the same way, but it is another place
  where a wrong assumption can hide. The hardware suite is what checks it.
- Playwright is a large development dependency. Installing it downloads no browser - the package
  has no install script - so a local run uses the Edge that is there, and CI fetches the one
  browser it needs with `npx playwright install`.
- The browser suite is not deterministic in the way the rest of the suite is. It is kept to
  scenarios whose outcome does not depend on an interleaving, and nothing in it is retried: a
  flaky browser test is a failing one, like any other.

### Risks and mitigations

- **The test runner's transform rewrites what is serialised into the page.** A `#private` class
  field in the stand-in becomes a call to a helper that does not travel with the source, and the
  page then throws before `navigator.serial` is replaced - leaving the _real_ Web Serial in place,
  which looks like a library bug. The stand-in therefore uses closures, and says so at the top of
  the file.
- **Every script an automation runs carries transient activation**, so a browser test cannot
  produce the `USER_GESTURE_REQUIRED` case at all: `page.evaluate()` is always "in a gesture".
  That case stays with the in-process suite; the browser suite covers the other half by clicking a
  real button.
- **A permission seeded into a profile depends on how Chromium stores it.** The format is read
  from Chromium's source, and a change in it makes the hardware tests fail by finding no port -
  visibly, not silently. The pref path is not the content setting's registered name: Chromium
  replaces `-` with `_`, so it is `serial_chooser_data`.
- **Hardware behaviour is the device's, not the library's.** The board used for the first run
  echoes at about 80 bytes a second whatever the line rate, and keeps echoing a large payload long
  after the browser has gone. The assertions are therefore about what arrived, not about how much
  arrived by when, and the payload carries a per-run seed so that an echo of an earlier run cannot
  be mistaken for this one's.

## Verification

- `test/browser/shared-port.spec.ts` - three tabs, one port, one `SharedWorker`; write attribution;
  a payload larger than a write chunk.
- `test/browser/failover.spec.ts` - the tab holding the port closes; its renderer is killed; and
  the broker that died with that renderer is replaced without any application action.
- `test/browser/transports.spec.ts` - the `BroadcastChannel` fallback, and a worker script of
  another protocol version reported as `PROTOCOL_VERSION_MISMATCH`.
- `test/browser/minified-entry.spec.ts` - `dist/index.min.js` sharing the port with the readable
  build.
- `test/browser/device-lifecycle.spec.ts` - the port picker from a real click, and an unplugged
  device coming back.
- `test/browser/hardware/arduino.spec.ts` - the same scenarios against an Arduino echoing on a COM
  port. Runs are recorded in [the manual test plan](../manual-test-plan.md).
