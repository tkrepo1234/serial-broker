# ADR-0023: Measure performance against expectations written first

- **Status:** Accepted

## Context

The library is for production interfaces (Introduction, "Who it is for"), and its users need to know
what it costs: how long a chunk takes to reach ten tabs, how long a write from a tab that does not
hold the port takes, how long a handover takes after a crash, or whether an hour of traffic leaves
timers or memory behind. Those numbers are wanted in two places - the simulated browser of
`test/harness/` and a real Chromium - for both transports, with one rule that shapes everything
else: **the expected value of every scenario is written down before it is measured**, and a result
more than ten times worse than its expectation becomes a fix or a documented limit.

Three things make this harder than a benchmark usually is:

1. **The harness has no real time.** Its clock moves when a test moves it, which is what makes
   the test suite deterministic (ADR-0012). A latency in the harness is therefore not a
   simulated quantity; it is the wall-clock time the process spent in the library's microtasks
   between the device pushing a chunk and a listener seeing it. That is the number that isolates
   the library's own cost, and it is also a number that varies with the machine.
2. **The harness's modules import each other by their `.js` names**, as the source does, and Node's
   own type stripping does not resolve those to `.ts` files. The test suite runs through Vitest's
   module loader; a benchmark is not a test, and Vitest's own benchmark mode is for micro-benchmarks
   of a function, not for a scenario across ten simulated tabs.
3. **A real browser's numbers depend on the machine**, and CI runners are shared machines whose
   timings say nothing. The browser test suite has a stand-in for Web Serial (ADR-0021),
   and a loopback says nothing unless a tab writes first.

## Decision

A `bench/` directory holds both benchmarks and one file of expectations.

- **Expectations are data**, in `bench/expectations.ts`: one set for the harness, one for the
  browser, each value with a comment saying why. A scenario without an expectation, or an
  expectation without a scenario, fails the run. The expectations are never adjusted to a result;
  a result far under them is reported as it is. The judgement - within, worse, more than ten times
  worse - is computed from the two and written next to them.
- **The harness benchmark** (`bench/harness/`) is TypeScript that drives `BrowserHarness` with the
  production classes, bundled by the esbuild the build uses and run in a Node of its own
  with `--expose-gc`. Every wall-clock metric is a percentile over many samples; every scenario
  also reports what the fake clock can say exactly - simulated time, timers scheduled - and checks
  that it did what it measures (every chunk in every tab, every write at the device) before it
  reports anything. It runs in about a second; the budget is two minutes.
- **The browser benchmark** (`bench/browser/`) is a Playwright suite on the same server and
  stand-in as the browser tests, on a port of its own, that runs only with
  `SERIAL_BROKER_BENCH_BROWSER=1` and never in CI. The stand-in has `emit()`, so that the device
  can push bytes without a write. Moments in different pages are compared on one clock,
  `performance.timeOrigin + performance.now()`, which the pages of a browser share; a chunk carries
  its push time in its first eight bytes, so the receiving page computes the latency itself.
- **Results are committed**: `bench/results/*.json`, and the Markdown fragments under
  `docs/site/_generated/` that the Performance chapter includes. The chapter therefore builds
  without a benchmark run, and the numbers a reader sees are the numbers that were measured, with
  the commit and the machine in the fragment's header. Generated files are excluded from Prettier.
- **Build sizes** are measured by `scripts/dist-sizes.mjs`, shared by `check-dist.mjs` - which
  prints them after every build, so CI reports them on every run - and by the benchmark, which puts
  them in the chapter. There is no size budget.

## Alternatives considered

- **Vitest's benchmark mode** (`vitest bench`, tinybench). It measures a function's operations per
  second across iterations; the scenarios here are one-shot flows across simulated tabs, with a
  clock that has to be advanced between writes, and their results are percentiles and counts, not
  ops/s. It would also make a benchmark look like a test, and a test that measures time is
  exactly what docs/guidelines/testing.md forbids.
- **Run the scenarios as a Vitest test file** and write results from it. Works, but a test file
  that is skipped in the normal run and writes files when invoked otherwise is a trap for whoever
  next touches `config/vitest.config.ts`. A runner of its own, bundled by esbuild, is ten lines and needs
  no test-runner state.
- **Add `tsx` or a loader hook** to run the TypeScript directly. One more development dependency for
  what esbuild, installed as the build's bundler, does in one call.
- **Expectations in the report, adjusted after each run.** That is a changelog, not an expectation.
  The expectation is what a result is judged against, so it cannot
  be adjusted afterwards; keeping it in a source file with a reason next to it is what makes that
  visible in review.
- **Git-ignore the results.** Then the Performance chapter would have nothing to include unless the
  documentation build ran the benchmark, which would put a two-minute, machine-dependent step into
  every `npm run docs`, in CI too. Committed results churn on every run, but the diff is what a
  reviewer wants to see when a change is meant to be faster.
- **Run the browser benchmark in CI.** A shared runner's timings vary by a factor of several
  between runs; a number nobody can compare is noise with a commit hash. The browser benchmark is
  recorded once per machine, by a person, as the hardware tests are.
- **A simulated hour of wall clock in the browser.** Nobody runs an hour-long benchmark, and the
  question - does traffic leave anything behind - is about volume, not elapsed time. The browser
  benchmark sends an hour's volume as fast as the pages take it and reads the heap through the
  DevTools protocol after a forced collection.

## Consequences

### Positive

- The library's cost is a number in the documentation, on both transports, with the reasoning for
  what it was expected to be, and a rule for what happens when a result crosses the line.
- A change meant to make something faster shows in a diff of `bench/results/harness.json`.
- The stand-in can play a device that speaks first, which the example applications can use as
  well.

### Negative

- The committed results change on every run, on every machine. The header says where a run was
  made; the ratio to the expectation is what to compare, not the absolute number.
- The harness's wall-clock numbers are not deterministic, which the test suite's numbers are. They
  are percentiles over many samples for that reason, and nothing gates on them.
- esbuild is a development dependency declared explicitly, at the version the build pins through an
  override.

### Risks and mitigations

- **A benchmark that measures a broken flow.** Every scenario checks that it did what it says
  before it reports - every chunk in every tab, every write at the device, the port opened exactly
  as often as it should - and throws otherwise.
- **Comparing clocks across pages.** `performance.timeOrigin + performance.now()` is the system
  clock in every page of one browser, but each page converts it on its own. In an
  NTP-style exchange over a `BroadcastChannel` between ten pages in Edge,
  the pages' clocks agree within 0.05 to 0.3 ms. That is the size of the smallest latencies
  measured, so a sub-millisecond latency between pages is a bound - under a millisecond - and not
  an exact value; the chapter says so. A crash is ordered from the test runner, so that scenario's
  numbers include the DevTools round trip; the time the browser takes to notice the crash is taken
  out by a plain Web Lock the crashed page held, and the chapter says that too.
- **The results going stale.** Each fragment names the commit it was measured at, and the chapter
  says how to run the benchmarks again.

## Verification

- `npm run bench` runs the harness scenarios in about a second and rewrites
  `bench/results/harness.json` and `docs/site/_generated/`; `npm run typecheck` includes
  `bench/tsconfig.json`; `npm run lint` covers `bench/`.
- `SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser` runs the browser scenarios in Edge and
  rewrites `bench/results/browser.json`; the results are in
  `docs/site/performance.md`.
- `npm run docs` builds the Performance chapter from the committed fragments and fails on any
  warning, so a missing fragment fails the build.
