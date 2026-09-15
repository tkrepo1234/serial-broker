# Contributing

Thank you for considering it. This library coordinates a physical resource across contexts
that can disappear at any moment, so the bar for changes is higher than the size of the
codebase suggests.

## Before you write code

Read [the engineering guidelines](./docs/guidelines/). They are binding, not advisory, and
they are short. The three that decide most reviews:

- [Defensive Programming](./docs/guidelines/defensive-programming.md) — what may be trusted,
  and where.
- [Testing](./docs/guidelines/testing.md) — including the scenario matrix every release must
  keep green.
- [API Design](./docs/guidelines/api-design.md) — what the public surface may and may not say.

If you are changing how contexts coordinate, read [ADR-0005](./docs/adr/0005-owner-election-via-web-locks.md)
and [ADR-0013](./docs/adr/0013-write-ordering-and-delivery-semantics.md) first. Both record
decisions that look replaceable and are not.

## Setting up

```sh
npm install
npm test           # a few seconds
npm run verify     # format, lint, type-check, tests with coverage gates, build: CI's first job
npm run docs       # the documentation site: CI's second job
npm run test:browser  # the built package in a real browser: CI's third job
```

Node 22.13 or newer on the 22 line, or 24 or newer: that is what Vitest and ESLint require. CI
runs Node 24. The library itself never runs in Node — that is only the toolchain.

The [device emulator](./emulator/README.md) (`npm run emulator`) is the exception: it runs its
TypeScript sources directly, on Node's built-in type stripping, and so needs a Node that has it
switched on by default — 22.18 or newer on the 22 line.

`npm run docs` also needs Python, in a virtual environment at `docs/.venv`. Create it once with
`python -m venv docs/.venv`, then install `docs/site/requirements.txt` with that environment's
`pip`. The build fails on any warning, in CI as locally.

`npm run test:browser` builds the package and runs the browser suite (`test/browser/`, ADR-0035)
against **the Microsoft Edge you already have installed** — no browser is downloaded. It serves
`dist/` on `http://localhost:8146`; set `SERIAL_BROKER_BROWSER_TEST_PORT` if that port is taken,
and `SERIAL_BROKER_BROWSER_CHANNEL` (`chromium`, `chrome`, `msedge`) to use another browser, which
is what CI does after `npx playwright install --with-deps chromium`. Pass Playwright's own
arguments after `--`, for instance `npm run test:browser -- --headed test/browser/failover.spec.ts`.

The same suite has a part that needs a real device, in `test/browser/hardware/`. It is skipped
unless you ask for it, and it **runs on Windows only**: the permission is seeded into the browser
profile as a Windows device instance ID, read with `Get-CimInstance Win32_PnPEntity`, so on any
other platform no port is found and the tests fail rather than run.

```sh
SERIAL_BROKER_HARDWARE=arduino npm run test:browser -- test/browser/hardware
```

```powershell
$env:SERIAL_BROKER_HARDWARE='arduino'; npm run test:browser -- test/browser/hardware
```

That runs seven tests. The 64 KiB round trip runs against the USB/IP emulator
(`SERIAL_BROKER_HARDWARE=emulator`) rather than the board, which echoes at about 80 bytes a second
and took a quarter of an hour for it. `SERIAL_BROKER_HARDWARE_PORT` picks the port when several of
these boards are attached.

It expects an Arduino (USB `0x2341`/`0x0078`) on a COM port, running a sketch that echoes every
byte it receives at 9600 baud, and nothing else using that port. The browser is handed the
permission through a throwaway profile written before it starts; nothing clicks a permission
prompt and no machine-wide setting is changed. Record what you saw in
[the manual test plan](./docs/manual-test-plan.md).

With [usbip-win2](./emulator/README.md) installed, `SERIAL_BROKER_HARDWARE=emulator` runs the same
suite's `emulator.spec.ts` against the USB/IP emulator instead. It needs no device: the spec starts
the emulator, lets usbip-win2 attach it, and unplugs, hangs and slows it down on cue. Nothing else
may be listening on port 3240, and `SERIAL_BROKER_USBIP` points at `usbip.exe` if it is not in
`C:\Program Files\USBip`.

### Benchmarks

`npm run bench` measures what the library costs on the simulated browser - latency and throughput
from the device to 1, 5 and 10 tabs, write latency, handover and start times, an hour's steady
state, over both transports - in about a second, and judges every number against the expectation
written down for it in `bench/expectations.ts` (ADR-0037). It writes `bench/results/harness.json`
and the fragments under `docs/site/_generated/` that the documentation's Performance chapter
includes; commit them with a change that is meant to be faster, or that touches what they measure.

The same scenarios run in a real browser with `SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser`
(PowerShell: `$env:SERIAL_BROKER_BENCH_BROWSER='1'; npm run bench:browser`), in the installed Edge,
on port 8147, in about ten minutes. That run is never part of CI: its numbers are one machine's, and
they are recorded once in the chapter with the machine named. A result more than ten times worse
than its expectation has to become a fix with a test, or a limit recorded in the chapter.
The **extreme suite** measures what the library costs at sizes no operator reaches - a hundred
tabs, an hour of full-rate traffic, ten thousand writes under crashes, a simulated week - and
asserts bounds on memory, timers, listeners, locks and messages. It is opt-in, never runs in CI,
and records its last run in `test/integration/extreme/RESULTS.md`:

```sh
npm run test:extreme                       # the simulated browser, about a minute
SERIAL_BROKER_EXTREME=1 npm run test:browser -- test/browser/extreme --workers=1   # Edge, six minutes
```

Every size has a `SERIAL_BROKER_EXTREME_*` variable; see
[the testing guideline](./docs/guidelines/testing.md#the-extreme-suite). Run it after a change to
`src/client/`, `src/worker/` or `src/owner/`, and commit the updated `RESULTS.md` with the change.

## Making a change

1. Branch: `<type>/<short-description>`.
2. Write the failing test first. For anything touching `src/client/`, `src/worker/` or
   `src/owner/`, that test belongs in `test/integration/multi-tab/` and must run against both
   transports.
3. Make it pass.
4. `npm run verify` must be green, including the coverage gates — and `npm run docs`, if the
   change touches documentation or TSDoc, and `npm run test:browser`, if it touches anything the
   browser suite loads: `src/`, the build, or `test/browser/` itself.
5. Commit with [Conventional Commits](./docs/guidelines/git-workflow.md). The body explains
   _why_; the diff already shows _what_.
6. Update `CHANGELOG.md` if the change is user-visible, and TSDoc on every touched export.
7. Write an ADR if you made or reversed an architectural decision, and reference it from the
   code.

## Before a release

Work through [the manual test plan](./docs/manual-test-plan.md) against real hardware and
record the result. The simulated browser is faithful, but a fake that is wrong in the same way
as the code passes every test.

## Releasing

Every version gets a GitHub release, created by `.github/workflows/release.yml` when its tag is
pushed. A version with a pre-release part, such as `0.1.0-alpha.1`, gets one marked as a
pre-release. Nothing is published to npm before 1.0.

1. Rename the `[Unreleased]` section of `CHANGELOG.md` to the version and date, such as
   `## [0.2.0] - 2026-10-01`, and start a new, empty `[Unreleased]` above it. The release notes
   are taken from that section; without it, the release fails before anything is built.
2. Set `version` in `package.json` to the same version, and commit both.
3. Run `npm run release:check`. It prints the notes the release will carry, or says what is
   missing.
4. Tag the commit and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.

The workflow checks that the tag matches `package.json`, runs `npm run verify`, and creates the
release with the notes and the packed package (`serial-broker-0.2.0.tgz`) attached.

## What gets a change rejected

- A test that depends on real time, real randomness, or incidental task ordering.
- A test that reaches into private state to assert an implementation rather than a contract.
- A retry of a write that may already have reached the device. Ever.
- A new field on the public surface that reveals which context owns the port.
- `catch {}` with no comment saying why the error is genuinely uninteresting.
- An `await` between a state check and the action that depends on it, with no re-check.

## Reporting a bug

Include the browser version, the operating system, the device, how many tabs were open, and
the `code` and `context` of any `SerialBrokerError` you saw. A multi-tab timing bug is almost
impossible to act on without those.
