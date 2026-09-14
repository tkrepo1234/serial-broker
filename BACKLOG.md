# Backlog

Work that is agreed but not yet started. Ordered by when it becomes relevant, not by size.

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
5. **Framework integration:** one component framework (React), as a hook.

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
- [ ] Size budgets are enforced by `scripts/check-dist.mjs`, so CI fails when a build exceeds them:
      `index.min.js` at most 25 KB gzipped, `serial-broker.worker.js` at most 12 KB gzipped.
- [ ] Every result more than ten times worse than its expectation has become a fix or a
      documented limit.

**Example apps**

- [ ] The five apps exist. Each starts with one documented command, type-checks in CI, and has a
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
