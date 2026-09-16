# Backlog

Work that is agreed but not yet started. Ordered by when it becomes relevant, not by size.

---

## Release readiness (Tim, 2026-09-15)

**No tag until Tim says so.** The code base is brought into order first and the release is made
ready; the version and the date go into the changelog when Tim decides.

- [x] The changelog's Unreleased section reads as the net change since `v0.1.0-alpha.1`, with an
      Upgrading section, every statement checked against the tag and `main`.
- [x] The release workflow runs all of CI before it releases, marks only pre-release versions as
      pre-releases, and has a dry run (`workflow_dispatch`) that uploads notes and package; the dry
      run passed on 2026-09-15.
- [x] Every step of `docs/manual-test-plan.md` names the suite that runs it; steps 4, 11, 12, 16
      and 19 were added to the emulator suite. What stays by hand: 1, 2, 4a, 7, 18, 22's display,
      26, 29's hidden tab, and unplugging a physical adapter once.
- [x] A second pass over every test file (1 410 → 1 345 tests).
- [x] A documentation drift check against the code, and a cold-read usability test of ten industrial
      use cases built from the documentation alone (below).
- [ ] At release: move Unreleased into `## [x.y.z] - date`, bump `package.json`, run the manual steps
      that stay by hand against a physical adapter, then tag. Tim's call.

## Usability findings of the cold read (2026-09-15)

Three reviewers built ten use cases - a weighing display, a tare command, choosing a device, an
exclusive press control, no automatic reconnect, changing the adapter, a support diagnostics page,
a deployment without a bundler, logging for support and a binary protocol - from the documentation
alone. Their notes were kept in the session scratchpad; what they found is decided here.

Done in the same round:

- `connection.autoReconnect: false` no longer reconnects through a handover, and `isRetryable` says
  whether the library is recovering (ADR-0010).
- `requestAccess(name, { chooseAgain: true })` chooses a different device in auto mode (ADR-0036).
- Found while answering the reviewers' questions: a write rejected with `started: false` could still
  be written when tabs ran different `writeTimeoutMs`, or when the request reached the tab holding
  the port late. The tab holding the port now asks the issuing tab before it begins a write from it
  (protocol version 14, ADR-0013), which also closes the crash exception to at-most-once.
- The Arduino suite's first test could not open COM3 on 2026-09-15 evening while a program outside
  the browser held the port (Web Serial alone failed too). Run again with the port free on
  2026-09-16: **5 of 6 tests pass**, and `echoes a payload larger than the write chunk` fails because
  the board loses what arrives from roughly 255 bytes on - measured with Web Serial alone, without
  the library, and recovering for small payloads right afterwards. Both runs are in the manual test
  plan. **Before the release**, run that test against a board that keeps up (a power cycle, a sketch
  that reads while it writes, or flow control); the emulator's 64 KiB round trip covers large
  payloads meanwhile.
- Documentation: deploying on a web server (files, a strict CSP with the import map, cache headers,
  a checklist), one import-map specifier, operator stations (every window watches, one operates),
  the framing and request/answer examples fixed, and every contradiction the reviewers logged.

Not now, each a candidate for after the release:

- A request/answer helper (`request(name, data, { answer, timeoutMs })`) with cross-tab exclusivity,
  and a bounded line splitter as a library export instead of example code.
- Diagnostics that name a tab in human terms (path, title, visibility, an application label) and
  keep a short error history per configuration.
- `logPayloads` switchable at run time and applied by whichever tab holds the port.
- A `VERSION` export and a version marker in the worker script.
- A marker on `ReceiveEvent` that bytes were lost before it (after a handover or a reconnect).
- A reason on each status change (device lost, handover, released).
- A `forgetAll()` for decommissioning a workstation.
- An exclusive-control mode in the library (one window sends, every window receives).

---

## Decided on 2026-09-14

Tim's answers to the open questions, so that the work below needs no further input. Where an item
further down says otherwise, this section wins.

### Release and distribution

- Tag **`v0.1.0-alpha.1`** now. A stable `v0.1.0` follows once the library has served a real or
  emulated port.
- **npm: not before 1.0.** At 1.0, bring the question back to Tim.
- The repository stays **private** until Tim says otherwise. License stays MIT, "serial-broker
  contributors".
- The README says clearly at the top that this is an alpha, that the API may change, and that it has
  not yet been verified against real hardware; the notice goes once the hardware test has passed.
- Documentation site: a CI artifact and local builds for now, **GitHub Pages later**.

### Security and package

- The debugging surface keeps asking before it uses a worker URL that only a link names.
- `devEngines` stays.
- `debug/index.html` gets a meta content security policy, tested in a browser; the advice to send
  `frame-ancestors` as a header stays.
- Enable GitHub's **private vulnerability reporting** and name it in `SECURITY.md`. GitHub offers it
  for public repositories only (the API answers 404 for this private one), so `SECURITY.md` names it
  now, and it is switched on when the repository becomes public.
- Dev dependencies stay on TypeScript 6 and `@types/node` 22: typescript-eslint and typedoc do not
  support TypeScript 7 yet, and Node 22 is the oldest Node the toolchain supports. Check again at
  the monthly update.

### Target audience: industry (Tim, 2026-09-14)

The library is for **industrial use**: production interfaces where simple, robust installation
matters. README, the documentation's introduction and the package description say so. Every
design decision, example and documentation chapter is judged against that audience first: one
package and one worker script to install, no native helpers, behaviour that is predictable on a
production line, and errors that say what to do.

### Device identity: explicit or automatic (Tim, 2026-09-14) - done

Done on 2026-09-14 (ADR-0036, protocol version 9): `device` omitted or `{ auto: true }` takes the
device from the chosen port, `{ nonUsb: true }` is the new kind for ports without a USB identity,
`getStatus()` reports `deviceKind`, and the debugging surface's **Choose a device…** uses the mode.
An auto-mode configuration waits for the user even when exactly one port is granted. Since
2026-09-15 the real-browser suite runs auto mode (`device-lifecycle.spec.ts`: the picker, a second tab
adopting the device, a later visit opening it unasked), step 4a of the manual test plan is the
debugging surface's auto-mode flow, and the OpenUI5 example's Reader runs in auto mode. The hardware
suites seed a permission and cannot answer a picker, so they keep explicit devices; the other
examples keep `{ any: true }`, which a first page needs.

The original request, for the record:

Vendor and product ID must always be optional. A configuration is set up either **explicitly**, with
`device: { vendorId, productId }` or `{ any: true }` as today, or in **auto mode**, with `device`
omitted or `{ auto: true }`: the library then takes the type, vendor ID and product ID from the
device the user chooses in the browser's port picker.

- In auto mode, `setup()` reports `awaiting-permission` until `requestAccess()` opens an unfiltered
  picker. The chosen port's `getInfo()` decides the effective device: `{ vendorId, productId }` for a
  USB device, and a port without a USB identity becomes a device of its own kind that matches only
  ports without one.
- The effective device is remembered with the configuration (so `restore()` and later visits
  reconnect to that device without a prompt), reported in `getStatus()` (`vendorId`, `productId`),
  and shared with the other tabs of the configuration through the status message, so a tab set up
  in auto mode adopts the device another tab chose. An auto-mode configuration never conflicts with
  a resolved one of the same name.
- Until the user has chosen, an auto-mode configuration with exactly one granted port could use it;
  decide this in the ADR (the safer default is to wait for the user).
- The debugging surface's "Choose a device" action is this mode: it no longer needs a form of its
  own for the identity, only the line settings.
- Implement after the hardening branches are merged (they touch the same files), with an ADR,
  docs/site/configuration.md and the examples updated.

### Debugging surface as an entry point (Tim, 2026-09-14) - done

- Connect to a device without typing a vendor ID, product ID or type: a **Choose a device** action
  opens the browser's port picker with no filter, takes the vendor and product ID from the chosen
  port - or `device: { any: true }` for a port without a USB identity - suggests a name and a baud
  rate the user can change, and sets the configuration up. It is the first thing a developer trying
  the library should find. Done the same day (ADR-0034); once the library has an automatic device
  mode (above), the action becomes that mode.

### Hardening (protocol version 8) - done 2026-09-14

Done, see the CHANGELOG and ADR-0028 to ADR-0031: a secret in `hello`; one Web Lock per term; the
four session checks; rate limits for status and diagnostics answers, malformed-message warnings,
remote errors and observer reports. What the implementers left open is under "Follow-ups from the
hardening round" below.

### Robustness - done 2026-09-14

Done, see the CHANGELOG and ADR-0032, ADR-0033: one storage key per configuration plus an index
(storage version 2, no migration); a monotonic clock for durations; the worker's `warn` records
forwarded to the tabs (ADR-0029); structural Web Serial types, every emitted declaration checked
without `@types/w3c-web-serial`.

### Tests, hardware and examples

- Hardware: Tim installs usbip-win2 0.9.8.0; the library is then tested against the USB/IP emulator.
  Installed on 2026-09-14; the machine restarts once the current work is done, and the emulator test
  follows the restart.
- **Real hardware is available (Tim, 2026-09-14):** an Arduino on COM3 (USB `2341:0078`) runs an
  echo sketch at 9600 baud with default settings: it sends back what it receives. Done the same
  day: `test/browser/hardware/arduino.spec.ts` runs against it (opt-in, ADR-0035), and the run is
  recorded in `docs/manual-test-plan.md`.
- **Long-running and extreme-usage tests (Tim, 2026-09-14):** many tabs, large amounts of data, long
  running times, for the edge cases of an extreme power user. They measure what the library
  consumes - memory, timers, listeners, locks, messages - and whether it stays stable, in the
  simulated browser and in a real browser.
- Real-browser tests with **Playwright**, locally and in CI. Done 2026-09-14 (`npm run
test:browser`, ADR-0035); the Web Serial stand-in in `test/browser/stand-in/` is for the example
  apps too.
- **No size budget**: sizes are reported, not enforced.
- Framework integrations for React, Vue, Svelte and Angular, and above all **SAP OpenUI5**: a runnable
  example app plus a reusable integration module (model binding and events), on the current OpenUI5
  long-term maintenance version, with UI5 Tooling and TypeScript, running without an SAP system.
- Dev dependencies are updated now, `npm audit fix` included, and checked monthly after that.
- The at-a-glance illustration is reworked in the documentation's style and then **shown to Tim for
  his assessment** before it goes into the documentation. Reworked on 2026-09-14
  (`design/at-a-glance.svg`, `design/README.md`); Tim's assessment is pending.

### Working mode

- Push after `npm run verify` and `npm run docs` pass; never force-push without asking.
- Agents and multi-agent workflows as the work needs them.
- Before 1.0, anything may break: protocol, storage, API. The CHANGELOG says so.
- Decisions that come up during the work are taken, recorded as an ADR or in the CHANGELOG, and
  listed in the final report. Only what cannot be undone or reaches outside - force-pushes, the
  repository's visibility, costs, accounts, npm - is asked.
- One final report per piece of work, no interim reports. The debugging surface (port 8123) and the
  documentation (port 8124) are left running at the end.

---

## Complexity and code reduction (Tim, 2026-09-14)

**Requested by Tim, 2026-09-14, to start once the work in progress on that day is merged.** After
many iterations everything has grown - on 2026-09-14: 12 900 lines in `src/` (50 files), 21 300
lines of tests (89 files), 9 500 lines of Markdown, 36 ADRs, 19 protocol message types. The
library's complexity has to come down sharply, above all the synchronisation protocol. Shrinking
after this many iterations is what hardens the product now.

### Scope

- **The synchronisation protocol.** Fewer message types, fewer states, fewer special cases. Each of
  the layers added over time - terms, term locks, tab slots, persistence holds, accepted writes,
  owner terms, pending writes, late deadlines, rate limits, record forwarding - is questioned:
  what does it protect against, is there a simpler mechanism that covers the same case, can two of
  them become one? The guarantees stay (at-most-once writes, failover without cooperation,
  exclusive use, no coordination vocabulary on the public surface); the machinery that provides
  them shrinks.
- **Code.** Remove what is dead, duplicated or only there for a case that no longer exists; merge
  modules that only exist to be small; make the remaining code read top-down. Measure before and
  after (lines, files, message types, cyclomatic complexity where a tool gives it).
- **Documentation.** Find duplicated statements across README, the site chapters, ADRs,
  SECURITY.md, CONTRIBUTING.md, the guidelines and TSDoc, and keep each fact in one place with
  links from the others. Check every statement against the code (documentation drift) and every
  documented behaviour against a test (code drift). Shorten.
- **ADR roll-up.** Merge ADRs that amend each other into one current decision each (with the
  history kept as a short "superseded" trail), retire ADRs whose decision no longer exists, and
  renumber nothing - a superseded ADR keeps its number and points forward.
- **Tests.** Walk the whole test base for duplicates (the same behaviour pinned twice under
  different names, in unit and integration alike), for tests of code that is gone, for tests that
  assert an implementation rather than a contract, and for slow tests that a faster one covers.
  Keep the scenario matrix in docs/guidelines/testing.md as the yardstick for what must remain.
- **The project directory.** A thorough clean-up: leftover files, scripts nobody runs, generated
  artefacts, stale configuration, `.gitignore` and ignore lists that name things that no longer
  exist, the top-level layout.

### Definition of done

**Status, 2026-09-15:** done in one pass the same day; the inventory before and after is
`docs/reviews/2026-09-15-reduction-inventory.md`.

- [x] A written inventory before the work starts, and the same inventory afterwards.
- [x] `src/` is materially smaller - 14 533 → 13 267 lines, 19 → 15 message types - with every
      scenario of docs/guidelines/testing.md green, the real-browser, emulator, Arduino, extreme and
      example suites included; the numbers are in the CHANGELOG.
- [x] Every fact in the documentation lives in one place (Guarantees for the promises, Configuration
      for the options); the drift found was fixed, and `test/unit/documentation.test.ts` checks
      documented defaults, ranges and log events against the source.
- [x] The ADR index shows only current decisions (24) plus a superseded trail (17 stubs).
- [x] No two tests pin the same behaviour; no test covers code that is gone. The duplicates the
      inventory named were removed, and a second pass over every test file on 2026-09-15 took the
      in-process suite from 1 410 to 1 345 tests; what it kept on purpose is in the CHANGELOG.
- [x] The repository root and every directory contain only what is used, and the top-level README
      describes the layout.

P3 and P4 from the usability review were done the same day (see "Performance tests, example apps and a
usability review").

---

## Performance tests, example apps and a usability review

**Requested by Tim, 2026-09-14. Scheduled after the hardening round.** Test the software the way
its users meet it: how fast it is, how it holds up in realistic applications, how much it takes to
do simple things, and whether the documentation explains everything clearly and without ambiguity.

**Status, 2026-09-15:** done. The benchmarks (`npm run bench`, `bench:browser`, the Performance
chapter, ADR-0037) and the extreme-usage suites (`npm run test:extreme`, the 20-page browser run)
found one limit, the crash of the tab that started the worker (under "Follow-ups from the hardening
round"). All nine example applications exist with smoke tests. The usability review is
`docs/site/tasks.md` and `docs/reviews/usability-review-2026-09-14.md`. What it and the examples left open:

- **P1, a defect in auto mode:** a later visit that calls only `setup()` asks for the device again
  and overwrote the remembered resolution. Fixed on 2026-09-15 (ADR-0036, amendment): `setup()` in
  auto mode takes a remembered auto-mode resolution, and the documentation no longer calls
  `restore()` first.
- **P2:** done on 2026-09-15 (ADR-0010, amended): `setup()` with equal options starts a `failed`
  configuration again, from any tab; the example applications use it.
- **P3:** done on 2026-09-15: a new `onStatusChange` listener receives the current status once, and no
  example calls `getStatus()` right after `subscribe()` any more.
- **P4:** done on 2026-09-15 (ADR-0036): `requestAccess()` works from any tab taking part; the holding
  tab looks for the granted port again when told, with the device chosen in auto mode.
- P2 to P4 change the API's behaviour; weigh them in the complexity reduction, where each removes
  a step every example now takes.
- Examples: done on 2026-09-15 - `examples/openui5`'s regular expression uses escapes, and its
  Reader runs in auto mode, so it no longer takes the Printer's port and one example shows the mode.
  The minimal and multi-tab-dashboard READMEs agree with Installing: Vite finds the worker through
  `new URL(..., import.meta.url)`, and naming it is recommended. The Angular and OpenUI5 examples
  record their install-script decisions in `allowScripts` (npm 11): esbuild's check of its binary
  runs; lmdb, msgpackr-extract and @parcel/watcher use their prebuilt binaries instead of compiling;
  the UI5 tooling scripts, which only edit `ui5.yaml` when asked to, do not run. The Svelte
  example's `$state.snapshot(options)` stays: the options may be a `$state` proxy, which cannot be
  passed between tabs.

### Performance

Measured in two places: in the simulated browser (`test/harness/`), where the library's own cost is
isolated and repeatable, and in a real Chromium, with a page-level Web Serial stand-in or the
emulator (`emulator/`), where the platform's cost is included.

| Scenario        | Measures                                                              |
| --------------- | --------------------------------------------------------------------- |
| Device to tabs  | Bytes per second and p50/p95 latency to `onReceive`, 1/5/10 tabs      |
| Tabs to device  | p50/p95 write latency at 1, 10, 100 writes per second; one 1 MB write |
| Handover        | Time from the owner's crash or release to the next `open`             |
| Start           | `setup()` to `open` with a granted device                             |
| Steady state    | Heap and pending timers after one simulated hour of traffic           |
| Both transports | Every scenario over `SharedWorker` and `BroadcastChannel`             |

Before measuring, write down the expected value for each scenario. The expectation is what a
result is judged against, so it cannot be adjusted afterwards.

### Example apps

Runnable applications under `examples/`, each with its own README and one command to start it,
using only the published entry points:

1. **Minimal:** one page that connects, prints received lines and sends text.
2. **Multi-tab dashboard:** several tabs on one device, status, errors, the permission flow,
   remembering and restoring.
3. **Exclusive operation:** `maxTabs: 1`, with the `queued` state shown to the user.
4. **Without a bundler:** `serial-broker/min` with an import map.
5. **Framework integrations:** SAP OpenUI5 first - an example app and a reusable integration module
   (see "Decided on 2026-09-14") - then React as a hook, Vue as a composable, Svelte as a store and
   Angular as a service.

Each app runs against the Web Serial stand-in without hardware, and against a real device.

### Usability review

- **Steps:** for connecting and printing received text, sending a command and awaiting it,
  showing the status, asking for permission, releasing, and exclusive use, count the calls, options
  and concepts needed. Put them next to the same task done with Web Serial alone.
- **Cold read:** a reviewer with no knowledge of the code builds each example app from the
  documentation alone and logs every question they had to ask and every guess they had to make.

### Definition of done

Everything below holds, and nothing beyond it is part of this item.

**Performance**

- [x] `npm run bench` runs the harness scenarios in under two minutes and writes their results,
      with the expectations next to them, to a Performance chapter of the documentation site.
- [x] The real-browser numbers for the scenarios above are recorded once in the same chapter, with
      browser, operating system and device or stand-in named.
- [x] `scripts/check-dist.mjs` reports the gzipped size of every build in CI. There is no size
      budget (decided on 2026-09-14).
- [x] Every result more than ten times worse than its expectation has become a fix or a
      documented limit.

**Example apps**

- [x] The apps above exist, one per framework integration. Each starts with one documented command, type-checks in CI, and has a
      README that says what it shows.
- [x] A smoke test per app runs in CI against the stand-in: the page loads, connects, receives and
      sends.

**Usability**

- [x] The step count for each task above is a table in the documentation, with the code for each
      task, and the Web Serial comparison.
- [x] No task needs a concept beyond `setup`, `subscribe`, `requestAccess`, `send` and `release`,
      or the task has a written design proposal that removes the extra step.
- [ ] The cold read is done for every app. Every logged question or guess is resolved, by a
      documentation fix or a recorded reason for leaving it, and the list is committed.

**Stop rule**

- [ ] Each area gets exactly one round of review, fix and re-review. What the re-review finds that
      is not a defect goes to this backlog as a new item, not into another round.

---

## Follow-ups from the hardening round of 2026-09-14

Protocol version 8 (ADR-0028 to ADR-0031), storage version 2 (ADR-0033), the monotonic clock
(ADR-0032), the worker's records in the tabs (ADR-0029) and the structural declarations are done.
What the implementers left open:

### Worker and bus

- ~~**A crash of the tab that started the SharedWorker stalls the other tabs for a minute.**~~ Done
  2026-09-15 (ADR-0041): the worker holds a Web Lock for its lifetime and every tab waits on it;
  the browser benchmark measured `handover/crash` `everyTab` at 325 ms at the median, down from
  60 s.
- A tab that connects after a worker record was written is never told about it: the worker keeps
  no buffer to replay. A small bounded replay to a newly registered tab would help an operator who
  opens a tab after the fact. The worker's records are not in the diagnostics observer's `collect()`
  either, and the debugging surface shows them like any other log line.
- ~~`MAX_BOUND_IDENTITIES` eviction is the residual weakness of ADR-0028.~~ Gone with the identity
  secret (ADR-0040, 2026-09-15): nothing is bound any more, and integrity rests on the term locks.
- The broker itself has no rate limit: it still routes and clones every well-formed message. Rate
  limits are per context, not per sender, so a flood can crowd legitimate answers out of the
  allowance (ADR-0031 says why per-sender rates were rejected).
- The remaining crash residual of ADR-0030 - a word a crashed holder sent that had not arrived when
  the browser freed its lock is too late - could be narrowed by draining the bus through the worker
  before a crashed term is decided; the `BroadcastChannel` has no equivalent hop.

### Storage

- The index is still one key every tab writes: a name added by two tabs within the propagation
  window can be lost and is only put back by that tab's next save. Entries left behind by an index
  that could not be read are never cleaned up. Both would need key enumeration
  (`Storage.length`/`key(n)`), which ADR-0033 rejected for now.

### Time and sleep

- ~~After the machine wakes, the broker's sweep can forget every tab before their heartbeats
  arrive.~~ Gone with the sweep (ADR-0041): who is still there is a Web Lock, not a timer.
- The debugging surface renders "in 1.4 s" / "320 ms ago" from wall-clock timestamps; a system clock
  jump skews those displays until the next report.
- ~~`BrokerHost.now()` / `WorkerPortsHost.now()` are monotonic but still called `now`.~~ Renamed to
  `monotonicNow()` on 2026-09-15.

### Browser and hardware tests

- **A stuck write is invisible in the status** (ADR-0038): while the device takes nothing, the status
  stays `open`. Since 2026-09-15 diagnostics report `stalledWriteSince` and log
  `supervisor.write-stalled`, and the debugging surface shows it; a public status for it is not planned.
- **Releasing a configuration while the device holds a write cannot close the port** - the platform
  keeps it until the page goes (ADR-0038). Measured with usbip-win2 only; whether a physical
  USB-serial adapter's driver ends such a write is unverified.
- ~~The emulator spec does not cover steps 10, 16 and 18-19.~~ Since 2026-09-15 it covers 4, 11, 12,
  16 and 19; step 10's crash path runs in the stand-in suite (the renderer killed over CDP) and in
  the emulator's step 24. Step 18, a permission revoked in the site settings, stays by hand.
- The seeded serial permission is Windows-only (device instance ID); macOS and Linux store vendor,
  product and serial number. CI exercises Chromium only.
- ~~The 64 KiB hardware round trip takes a quarter of an hour on the Arduino.~~ Removed on 2026-09-15;
  the emulator's 64 KiB test and the Arduino's 5 000-byte test cover it.
- No browser test for `USER_GESTURE_REQUIRED`: every script an automation evaluates carries
  transient activation. The stand-in has no fault injection yet (open/write failing or hanging, a
  non-USB port).
- `docs/manual-test-plan.md` quotes lock names of protocol versions 1 and 2 only inside the dated run
  records of 2026-09-12 and 2026-09-13, where they are what was observed then.

---

## Open findings from the bug hunt of 2026-09-13

Everything confirmed in the bug hunt is fixed. What remains is either unconfirmed or needs a real
browser or real hardware to settle:

- **What a dead worker swallowed is only partly asked for again** (a documented limit since
  2026-09-15: docs/site/known-limits.md, "Messages on their way when the bus changes are lost"). After reconnecting, the tab
  holding the port restates its status and writes that had not started are handed on (the owner
  recognises repeats). Errors and traffic broadcast into the dead worker are not repeated, and a
  write handed on this way may reach the device after a later write of the same tab that did get
  through - the ordering guarantee of ADR-0013 holds only while the bus delivers.
- ~~**Two tabs saving configurations at the same moment may overwrite each other's entry.**~~ Fixed by
  one key per configuration (ADR-0033); what remains of it is the shared index, under "Storage" above.
- **An unplugged device versus a revoked permission** (ADR-0010, amended) is told apart by the
  `disconnect` event. That Chromium sends no `disconnect` when a permission is revoked in site
  settings is assumed, not verified.
- **The back/forward cache and the debugging surface's observer.** The observer is no longer closed
  when the page is only cached; whether a page with an open `SharedWorker` or `BroadcastChannel`
  enters the cache at all depends on the browser.

---

## After beta: a full developer documentation site

**Requested by Tim, 2026-09-12. Explicitly scheduled for after the beta phase — then started early
at Tim's request on 2026-09-13.**

### Status

Started 2026-09-13. The toolchain questions below are decided in
[ADR-0020](./docs/adr/0020-documentation-toolchain.md): Sphinx with the Read the Docs theme,
chapters in Markdown (MyST), the API reference generated from TSDoc, Python in `docs/.venv`.
`npm run docs` builds `docs/site/`.

| Done                                                                | Still to do                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| Site skeleton, full outline, generated API reference                | Completing TSDoc where the generated reference is thin |
| Introduction, Installing, First connection                          | Hosting (GitHub Pages, once the repository is public)  |
| The CI job `docs` builds the site and uploads it as an artifact     |                                                        |
| How shared ports behave (the core chapter)                          |                                                        |
| Examples in all four tiers, type-checked by `npm run typecheck`     |                                                        |
| Configuration, Errors, Diagnostics, Internals                       |                                                        |
| Application API and Diagnostics API referenced in separate sections |                                                        |

### Found while writing the chapters

Checking every statement against the source turned up behaviour worth deciding on. A worker script
that fails to load now falls back to `BroadcastChannel` too (ADR-0007, amended). Fixed at once:
`SerialBroker.configure({ logPayloads })` was never passed on and did nothing, and the remediation
for `RECONNECT_EXHAUSTED` advised a second `setup()`, which is a no-op. Open, and documented as
they were: `STORAGE_CORRUPT` during `restore()` in a fresh tab only reached the log. Since the
bug hunt of 2026-09-13 such errors are kept for the first `onError` listener.

Build a product-grade documentation site for developers, modelled on
[open62541 1.3](https://open62541.org/doc/1.3/).

### Why 1.3 specifically

Version 1.3 is the requirement, not an approximation: that release still shipped the
**Sphinx** documentation with the theme Tim wants. Later open62541 versions moved away from
it. So:

- Sphinx as the generator.
- The 1.3 theme, not whatever Sphinx ships by default.
- Its structure and tone as the model for ours — 1.3 is well organised _in content_, not only
  in appearance, and that is the part worth copying.

### What it must contain

|                             |                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Examples, in four tiers** | _Simple_ (the smallest thing that works) → _All features_ (every capability, one at a time) → _Full-featured_ (a realistic application using them together) → _Advanced_ (the hard cases: failover, protocol layers on top, several devices).      |
| **Configuration options**   | Every option documented in depth: what it does, its default, its range, what changing it costs, and when you would. Not a table of one-liners.                                                                                                     |
| **How shared ports behave** | The core chapter. How coordination actually works internally, what an application can rely on, and what to watch out for — ownership transfer, the gap during a handover, write ordering across tabs, what `OWNER_LOST_DURING_WRITE` really means. |
| **Every API function**      | Each one documented in full: purpose, parameters, return value, every error it can raise, when to call it, and a worked example.                                                                                                                   |

The bar is **product-grade documentation for developers**, not a generated reference with
prose sprinkled on top.

### Open questions to settle before starting

- **Toolchain.** Sphinx is Python; this project's toolchain is Node. Decide whether to add a
  Python step, and whether the API reference is generated from TSDoc (typedoc → Markdown →
  Sphinx) or written by hand and kept in sync by review.
- **Hosting.** Where the built site lives.
- **Language.** English, consistent with the repository.

### Relationship to what exists now

The current `README.md`, `docs/site/internals.md` and the ADRs are the raw material and are
accurate. They are not a substitute: the README is a decision aid for someone evaluating the
library, and the ADRs record reasoning rather than teach use.

---

## Rework the at-a-glance illustration

**Requested by Tim, 2026-09-13.** One page showing what serial-broker achieves and how it fits into
an application's landscape: not marketing for its own sake, but the picture that lets a developer
facing the serial-broker problem recognise this as the solution, whichever feature they need.

A first draft is in `design/at-a-glance.svg`. It was taken out of the documentation until it has
been reworked; the rework has to match the documentation's colours and style.

**Reworked on 2026-09-14** in the documentation's palette and typography, with `design/README.md`
describing what it shows and how to embed it. It stays out of the documentation and the README until
Tim has assessed it. If accepted: embed it in `docs/site/introduction.md` (copy to `_static/`) and
the README, with alternative text.

---

## Open findings from the project review of 2026-09-13

The verified defects were fixed in `6d31c59` and the commits after it. What remains needs a decision or is larger work.

### Decisions

Decided by Tim on 2026-09-13 and done:

- Stored configurations have a storage version of their own and are moved from the old keys
  ([ADR-0022](./docs/adr/0022-version-stored-configurations-separately.md)).
- `MALFORMED_MESSAGE` and `OWNERSHIP_TRANSFER_TIMEOUT` are removed; `UNKNOWN` is what a code
  reported by a later version becomes.
- `LISTENER_THREW` is reported in the listener's own tab only.
- Tabs announce their protocol version on an unversioned channel
  ([ADR-0023](./docs/adr/0023-announce-the-protocol-version.md)).
- A late `configure()` logs `facade.late-configure`.

### Refactorings

Done on 2026-09-13: shared protocol guards, one conversion to setup options, a shared message
sender for both transports, `configNameOf()`, shared test helpers, the debugging surface's
duplicates, and the dead code.
