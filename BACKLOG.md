# Backlog

What is open. What the library contains is in the [changelog](./CHANGELOG.md), decisions and their
reasons are in the [ADRs](./docs/adr/README.md); neither is repeated here.

## Standing constraints

Not derivable from the code:

- **Audience: industry.** Production interfaces where simple, robust installation matters. Every
  design decision, example and documentation chapter is judged against that first.
- **A page has to run from a folder opened as a file**, with no web server and no internet.
- **A tag only on the owner's word.** Releasing is described in
  [CONTRIBUTING.md](./CONTRIBUTING.md).
- **npm: not before 1.0.** Whether to publish there is decided at 1.0.
- **The repository is private.** Two things wait for the day it is public: GitHub's private
  vulnerability reporting, which exists for public repositories only and is named in `SECURITY.md`,
  and hosting the documentation on GitHub Pages.
- **Two examples**, `examples/minimal-js` and `examples/terminal-openui5`. No framework integrations.
- **Not targets:** Chrome for Android; unplugging a physical adapter by hand; large payloads on the
  Arduino board.
- **No size budget.** Build sizes are reported, not enforced.
- Before 1.0 anything may break — protocol, storage, API — with an entry in the changelog.
- Dev dependencies stay on TypeScript 6 until typescript-eslint and typedoc support TypeScript 7;
  checked monthly, with `npm audit`.

## By hand, before a release

- **Step 18 of the [manual test plan](./docs/manual-test-plan.md):** revoke the device in the
  browser's site settings while connected. Not automatable — the settings pages offer no control a
  test can address. It would also settle an assumption of ADR-0008: that Chromium sends no
  `disconnect` when a permission is revoked.

## Candidates for the API

None is scheduled.

- Diagnostics that name a tab in human terms (path, title, visibility, an application label) and
  keep a short error history per configuration.
- `logPayloads` switchable at run time, applied by whichever tab holds the port.
- A reason on each status change: device lost, handover, released.
- `forgetAll()`, for decommissioning a workstation.
- An exclusive-control mode: one window sends, every window receives.
- XON/XOFF in software. Web Serial offers hardware flow control only.

## Known gaps

Each is a documented limit or a test that does not exist; none is a defect waiting for a fix.

**Worker and bus**

- A tab that connects after a worker `warn` record was written is never told about it: the worker
  keeps no buffer to replay. Its records are not in the diagnostics observer's `collect()` either.
- The broker has no rate limit of its own. Rate limits are per context, not per sender, so a flood
  can crowd legitimate answers out of the allowance (ADR-0019 says why the rates are not
  per sender).
- What a dead worker swallowed is only partly asked for again: errors and traffic broadcast into it
  are not repeated, and a write handed on afterwards may reach the device after a later write of
  the same tab (Known limits, "Messages on their way when the bus changes are lost").
- A word a crashed holder sent that had not arrived when the browser freed its lock is too late
  (ADR-0018). Draining the bus through the worker first would narrow it; a `BroadcastChannel` has
  no such hop.

**Storage**

- The index of remembered configurations is one key every tab writes: a name added by two tabs
  within the propagation window can be lost until that tab saves again, and entries left behind by
  an unreadable index are never cleaned up. Both would need key enumeration, which ADR-0020
  rules out.

**The platform**

- A stuck write is invisible in the status: while the device takes nothing, the status stays
  `open`. Diagnostics report `stalledWriteSince`; a public status for it is not planned.
- Releasing a configuration while the device holds a write cannot close the port — the platform
  keeps it until the page goes (ADR-0011). Measured with usbip-win2 only.
- Whether a page with an open `SharedWorker` or `BroadcastChannel` enters the back/forward cache
  depends on the browser; the debugging surface's observer survives either way.
- The debugging surface renders "in 1.4 s" from wall-clock timestamps, so a system clock jump skews
  the display until the next report.

**Tests**

- The seeded serial permission of the hardware suites is Windows-only; CI exercises Chromium only.
- No browser test for `USER_GESTURE_REQUIRED`: every script an automation evaluates carries
  transient activation.
- The extreme suite, both benchmarks and the background-tab run never run in CI. After a change to
  the protocol, run them: `npm run test:extreme`, `npm run bench`,
  `SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser`, `npm run test:background`.
