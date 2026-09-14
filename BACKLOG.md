# Backlog

Work that is agreed but not yet started. Ordered by when it becomes relevant, not by size.

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

### Device identity: explicit or automatic (Tim, 2026-09-14)

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

### Debugging surface as an entry point (Tim, 2026-09-14)

- Connect to a device without typing a vendor ID, product ID or type: a **Choose a device** action
  opens the browser's port picker with no filter, takes the vendor and product ID from the chosen
  port - or `device: { any: true }` for a port without a USB identity - suggests a name and a baud
  rate the user can change, and sets the configuration up. It is the first thing a developer trying
  the library should find.

### Hardening (protocol version 8)

- A secret in `hello`, bound to the identity by the worker.
- One Web Lock per term, replacing the one-second grace period.
- All four session checks: a write's outcome only from the term it was addressed to; claims and
  statuses checked against the locks; `data-received` and `data-sent` only from the current or
  awaited sender; a bound on the owner's queue of other tabs' write requests.
- Rate limits for answers to `status-request` and `diagnostics-request`, for malformed-message
  warnings and remote `error` events, and for observer reports per collection.

### Robustness

- Stored configurations: **one key per configuration plus an index** (storage version 2). Before
  1.0 nothing needs migrating.
- `Clock` gains monotonic time for durations; event timestamps stay wall-clock time.
- The worker forwards its `warn` records, throttled, to the tabs, which log them as `worker.*`.
- The internal declaration files use structural types, and `scripts/check-dist.mjs` checks every
  declaration file without `@types/w3c-web-serial`.

### Tests, hardware and examples

- Hardware: Tim installs usbip-win2 0.9.8.0; the library is then tested against the USB/IP emulator.
  Installed on 2026-09-14; the machine restarts once the current work is done, and the emulator test
  follows the restart.
- **Real hardware is available (Tim, 2026-09-14):** an Arduino on COM3 (USB `2341:0078`) runs an
  echo sketch at 9600 baud with default settings: it sends back what it receives. The library is
  tested against it in a real browser.
- **Long-running and extreme-usage tests (Tim, 2026-09-14):** many tabs, large amounts of data, long
  running times, for the edge cases of an extreme power user. They measure what the library
  consumes - memory, timers, listeners, locks, messages - and whether it stays stable, in the
  simulated browser and in a real browser.
- Real-browser tests with **Playwright**, locally and in CI.
- **No size budget**: sizes are reported, not enforced.
- Framework integrations for React, Vue, Svelte and Angular, and above all **SAP OpenUI5**: a runnable
  example app plus a reusable integration module (model binding and events), on the current OpenUI5
  long-term maintenance version, with UI5 Tooling and TypeScript, running without an SAP system.
- Dev dependencies are updated now, `npm audit fix` included, and checked monthly after that.
- The at-a-glance illustration is reworked in the documentation's style and then **shown to Tim for
  his assessment** before it goes into the documentation.

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

## Performance tests, example apps and a usability review

**Requested by Tim, 2026-09-14. Scheduled after the hardening round.** Test the software the way
its users meet it: how fast it is, how it holds up in realistic applications, how much it takes to
do simple things, and whether the documentation explains everything clearly and without ambiguity.

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

- [ ] `npm run bench` runs the harness scenarios in under two minutes and writes their results,
      with the expectations next to them, to a Performance chapter of the documentation site.
- [ ] The real-browser numbers for the scenarios above are recorded once in the same chapter, with
      browser, operating system and device or stand-in named.
- [ ] `scripts/check-dist.mjs` reports the gzipped size of every build in CI. There is no size
      budget (decided on 2026-09-14).
- [ ] Every result more than ten times worse than its expectation has become a fix or a
      documented limit.

**Example apps**

- [ ] The apps above exist, one per framework integration. Each starts with one documented command, type-checks in CI, and has a
      README that says what it shows.
- [ ] A smoke test per app runs in CI against the stand-in: the page loads, connects, receives and
      sends.

**Usability**

- [ ] The step count for each task above is a table in the documentation, with the code for each
      task, and the Web Serial comparison.
- [ ] No task needs a concept beyond `setup`, `subscribe`, `requestAccess`, `send` and `release`,
      or the task has a written design proposal that removes the extra step.
- [ ] The cold read is done for every app. Every logged question or guess is resolved, by a
      documentation fix or a recorded reason for leaving it, and the list is committed.

**Stop rule**

- [ ] Each area gets exactly one round of review, fix and re-review. What the re-review finds that
      is not a defect goes to this backlog as a new item, not into another round.

---

## Follow-ups from the hardening round of 2026-09-14

The hardening round bounded what the bus can make a tab or the worker hold, held each worker port to
its identity, and closed the lifecycle and re-entrancy defects it found. What it proposed but did not
do, because it needs a decision, a protocol change or a real browser:

### Needs protocol version 8

- **A secret in `hello`.** Each transport sends a random value only in `hello`; the worker binds the
  identity to it and refuses a later `hello` with another. Stops impersonation on the worker; not
  possible on `BroadcastChannel`.
- **One Web Lock per term** (`serial-broker/term/v8/<name>/<term>`), held by the owner for the whole
  term. Tabs take a term for ended when its lock is free, instead of after the one-second grace
  period, so a forged claim cannot end a live term and crash detection becomes exact.

### Tighter checks on what tabs believe

- `PendingWrites`: accept `write-started` and `write-result` only from a term the write was addressed
  to; today an outcome from any term settles it.
- Claims and statuses: refute a new term while the owner lock is not held (`locks.query()`), and a
  finite `maxTabs` without a matching tab-slot lock - one forged status makes every tab that does
  not hold the port withdraw.
- `data-received` and `data-sent`: accept only from the sender of the current or awaited term.
- Rate limits for answers to `status-request` and `diagnostics-request`, for the
  `client.malformed-message` warning, and for remote `error` events.
- Observer: cap reports per collection, and ignore a report whose `clientId` differs from its sender.
- The owner's write queue: bound the writes it holds for other tabs; forged `write-request`s with
  new request ids grow it.

### Time and sleep

- `Clock` has no monotonic time. `stableAfterMs` is measured on the wall clock, so a clock set back
  keeps the attempt counter from resetting.
- After the machine wakes, the broker's sweep can forget every tab before their heartbeats arrive;
  write messages in between are lost. Needs a real browser to confirm.
- The fake worker keeps every routed message, which grows test memory in long runs.

### Declarations

- The internal declaration files (`dist/owner/port-supervisor.d.ts`, `dist/environment/environment.d.ts`
  and a few more) still name the ambient Web Serial types, so they need `@types/w3c-web-serial` to
  type-check. No export path reaches them, and `scripts/check-dist.mjs` checks that the published
  entry points do not; structural types in `src/environment/environment.ts` would make them clean
  too.

---

## Open findings from the bug hunt of 2026-09-13

Everything confirmed in the bug hunt is fixed. What remains is either unconfirmed or needs a real
browser or real hardware to settle:

- **What a dead worker swallowed is only partly asked for again.** After reconnecting, the tab
  holding the port restates its status and writes that had not started are handed on (the owner
  recognises repeats). Errors and traffic broadcast into the dead worker are not repeated, and a
  write handed on this way may reach the device after a later write of the same tab that did get
  through - the ordering guarantee of ADR-0013 holds only while the bus delivers.
- **Two tabs saving configurations at the same moment may overwrite each other's entry.** `save()`
  and `remove()` rewrite one `localStorage` record, and Chromium commits `localStorage` across
  renderer processes asynchronously. Unconfirmed: it needs a real multi-process browser. The fix
  would be one key per configuration plus an index, or merging on the `storage` event.
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
| Introduction, Installing, Quickstart                                | A CI step that builds the site; hosting                |
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

The current `README.md`, `docs/architecture.md` and the ADRs are the raw material and are
accurate. They are not a substitute: the README is a decision aid for someone evaluating the
library, and the ADRs record reasoning rather than teach use.

---

## Rework the at-a-glance illustration

**Requested by Tim, 2026-09-13.** One page showing what serial-broker achieves and how it fits into
an application's landscape: not marketing for its own sake, but the picture that lets a developer
facing the serial-broker problem recognise this as the solution, whichever feature they need.

A first draft is in `design/at-a-glance.svg`. It was taken out of the documentation until it has
been reworked; the rework has to match the documentation's colours and style.

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
