# Performance

What serial-broker costs, measured: how fast bytes reach every tab, how long a write from a tab
takes to reach the device, how long a handover and a start take, and whether an hour of traffic
leaves anything behind. Every number stands next to the value it was expected to have, and the
expectation was written down before the first measurement.

On a production line the serial line itself is the limit. At 9600 baud a device produces about a
kilobyte a second; at 921 600 baud, about 90 KB/s. The library's own cost stays far below that in
every scenario. One result is over its expectation, by less than ten times: a handover after a
crash takes about 0.4 s, nearly all of it the browser noticing the crash — see
[Over the expectation](#over-the-expectation-by-less-than-ten-times).

## What is measured, and where

The same scenarios are measured in two places, and the two tables below are meant to be read side
by side.

- **The simulated browser** (`bench/harness/`): the library's production classes on the test
  suite's harness — a fake bus carrying the real broker, a fake serial registry, fake locks, and a
  clock that moves only when the scenario moves it. This isolates the library's own cost:
  structured clones, validation, dispatch, promise chains. It runs in one Node process, in about a
  second, with `npm run bench`, and it is repeatable to the extent that wall-clock time on one
  machine is.
- **A real browser** (`bench/browser/`): the built package in a Chromium, with the Web Serial
  stand-in of the browser test suite in place of a device, driven by Playwright. Everything the
  platform adds is in these numbers: a real `SharedWorker` hop, real `postMessage` cloning between
  processes, real Web Locks, a real renderer crash. It runs only when asked for
  (`SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser`), never in CI, and its numbers are
  recorded here once, with the machine that produced them.

Neither place has a serial line in it. The device is a fake that answers at once, so what is
measured is everything except the wire.

| Scenario                        | What is measured                                                                                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device-to-tabs/1`, `5`, `10`   | The device pushes 255-byte chunks (the default read buffer). Latency from the push to `onReceive` in each tab, one chunk at a time; throughput from a burst of 2000 chunks.                                                                           |
| `tabs-to-device/<n>-per-second` | A tab that does not hold the port sends a six-byte write every second, ten times a second, a hundred times a second. Latency from `send()` to its promise settling.                                                                                   |
| `tabs-to-device/1-mb-write`     | One `send()` of 1 MiB from that tab, to its promise settling, with the default 4 KiB write chunk.                                                                                                                                                     |
| `handover/crash`                | The tab holding the port is killed with no chance to clean up. Time until another tab reports `open` — in the browser, both the first tab (`wall`) and the last (`everyTab`), and the first against the moment the platform freed a lock (`library`). |
| `handover/release`              | The tab holding the port releases the configuration. Time until another tab reports `open` — in the browser, the first and the last.                                                                                                                  |
| `start/first-tab`               | A fresh browser with the device granted: from `setup()` to `open`.                                                                                                                                                                                    |
| `start/joining-tab`             | A tab joining a configuration another tab already holds open: from `setup()` to `open`.                                                                                                                                                               |
| `steady-state/one-hour`         | Three tabs, one chunk and one write a second for an hour. Heap growth, and — in the harness — timers still scheduled, compared after a minute of warm-up and at the end.                                                                              |

Every scenario runs over both transports: the `SharedWorker` broker, and the `BroadcastChannel`
fallback.

Two numbers in the harness table are not wall-clock time. **Simulated** time is how far the fake
clock moved: `0 ms` says that a handover or a start waited on no timer at all — the successor
opens the port as soon as the browser hands it the lock, and nothing in between is a delay the
library chose. **Timers** are the harness's count of scheduled timers, which the browser cannot
report; a difference would be a timer the library scheduled and never cleared.

The wall-clock numbers are percentiles over many samples — 500 chunks per tab, 60 to 500 writes,
20 fresh harnesses for a handover or a start in the harness, 5 fresh browser contexts in the
browser — because they vary with the machine and with what else it is doing. A run says which
machine it was made on. One tab in `device-to-tabs/1` is the tab holding the port, so that row
measures the holder's own read loop and dispatch, with no bus hop; the hops begin with the second
tab.

## The expectations

The expectations are data in `bench/expectations.ts`, one set for each place, and the reasoning
for each number is in a comment next to it. They were written before anything was measured, and
they are not adjusted to a result: the rule (ADR-0023) is that a result more than
ten times worse than its expectation becomes either a fix in the library, with a test, or a limit
written down in this chapter. A result that is far better than expected is left as it is; the
expectation stays what it was.

For the harness, the expectations follow from what a hop costs: a structured clone of a few
hundred bytes and a validation, tens of microseconds each. A chunk to one tab is two clones and a
validation, so 0.1 ms at the median and 2 MB/s in a burst; every further tab adds one clone and
one validation. The expectation for a write from a tab that does not hold the port reasons from
four hops; the write makes five, because the tab holding the port asks the issuing tab before it
begins. Handovers and
starts wait on no timer, so they should take no simulated time and a couple of milliseconds of
wall clock. After an hour, the heap should be within half a megabyte of where it started, with
the same timers scheduled.

For the browser, every hop is a real `postMessage` between processes at a few hundred
microseconds, so the latencies are ten times the harness's; a handover after a crash waits for
Chromium to notice that the renderer is gone, so a quarter of a second; and the megabyte is
echoed back by the stand-in in 255-byte pieces, four thousand of them, which was expected to be
the expensive part of that scenario.

The browser's `everyTab` and `library` metrics take their expectations from bounds written for the
same steps, not from a result: `everyTab` has the bound of the same handover's `wall`, and `library`
the bound written for a release, which reasons from the same steps between a free lock and `open`.

## The simulated browser

```{include} _generated/harness-benchmark.md

```

## A real browser

Recorded once, on the machine named below, with the Web Serial stand-in of the browser test
suite (`test/browser/stand-in/web-serial-stand-in.ts`) standing in for the device — a loopback
that can also be made to push bytes of its own. The rates are real time here, the simulated hour
is its volume of traffic as fast as the pages take it, and the heap is read through the DevTools
protocol after a forced garbage collection; the browser's timers cannot be observed from outside.
A handover after a crash is timed from the moment the test runner orders the crash, so `wall` and
`everyTab` include the DevTools round trip and the time Chromium takes to notice the crash;
`library` leaves both out.

```{include} _generated/browser-benchmark.md

```

## Build sizes

What an application installs, as built and gzipped, from `scripts/check-dist.mjs`, which prints
these after every build so that CI reports them on every run. There is no size budget: the sizes
are reported, not enforced. The worker script is served next to the
application whatever the entry point, so it is part of every installation.

```{include} _generated/build-sizes.md

```

## Results worse than expected

Nothing in the harness run is worse than its expectation. In the browser run, only the handover
after a crash is over its expectation, by less than ten times.

### Documented limits

**The benchmark measures deliveries as they are read.** Its configurations set `receive: { idleMs: 0 }`,
so `device-to-tabs` times the library and the bus, not the collection of received bytes (ADR-0002).
With the defaults, a delivery also waits until the line has been quiet for `receive.idleMs` (50 ms),
and on a line that never goes quiet for up to `receive.maxWaitMs` (500 ms); see
[Configuration](configuration.md). With the defaults, a stream that never pauses measures about
240 ms at the median, which is that wait and nothing else.

**The `SharedWorker` can end with the tab that crashes.** In Microsoft Edge 153 the `SharedWorker`
ends when the renderer of the page that started it crashes — usually the first tab, which is also
the first to hold the port. The worker holds a Web Lock for its lifetime, which every tab waits on
(ADR-0024), so every tab learns of it at once and no timer is involved: `everyTab` is as close to
`wall` on the `SharedWorker` transport as on the `BroadcastChannel` transport.

### Over the expectation, by less than ten times

- **A handover after a crash** (`wall` and `everyTab`): 349.3 ms at the median on the
  `SharedWorker` transport and 388.5 ms on `BroadcastChannel`, against 250 ms, with a 95th
  percentile of 676.5 ms and 854.8 ms. Almost none of it is the library's: `library` — the same
  moment against a plain Web Lock the crashed page held, freed by the browser in the same crash —
  is 6.500 ms and 6.100 ms at the median. The rest is Chromium noticing that the renderer is gone,
  plus the DevTools round trip that orders the crash. The first crash after the browser starts
  takes about twice as long as the ones after it. The expectation stays at 250 ms, so that the
  next run is judged against the same line.

### What else the numbers say

- **The browser's sub-millisecond rows are bounds, not exact values.** `performance.now()` in a
  page that is not cross-origin isolated has a resolution of 100 µs, and a latency between pages
  compares two pages' clocks. Checked once with an NTP-style exchange between ten pages over a
  `BroadcastChannel`, those clocks agreed within 0.05 to 0.3 ms — the size of the latencies
  themselves. What the `device-to-tabs` rows say with confidence is that a chunk reaches ten tabs
  in under a millisecond; which fraction of a millisecond, they do not.
- **The harness's heap reading is coarser than its expectation.** With no change to the library,
  the growth after the hour reads anywhere from -800 KB to +220 KB from run to run: what the garbage
  collector leaves behind varies by more than the 512 KB expected. The reading can still tell a
  leak: one chunk kept per tab per second would add about 2.6 MB over the hour. The timer count is
  exact.
- **The megabyte write is not dominated by the echo**: the write's promise settles in about 20 ms,
  before the stand-in has echoed the megabyte back, so the expectation of two seconds, which
  reasoned from the echo, was wrong in the safe direction. Against a real device the write itself
  takes as long as the line rate says — about eighteen minutes at 9600 baud — and the library's
  part of it is the harness number.
- **The harness results are 6 to 110 times under their expectations**, with the writes from a tab
  that does not hold the port on the `SharedWorker` transport closest to the line. The expectations
  reasoned from tens of microseconds a hop where the process spends a few; they stand as written,
  and a result is compared with them, not with the last run.
- **The harness cannot show a worker that ends with a crashed tab.** Its worker is a fake that
  outlives every tab, and its handover has two tabs, the second of which takes the port over.

A result that crosses the line becomes a fix in the library or a limit stated in this section.

## What the numbers do not say

- They say nothing about a real serial line. Every scenario above is far faster than any line the
  library will meet; the throughput rows say how much headroom there is, not how fast a device can
  be read.
- The browser numbers are one machine, one browser version, one day. They are recorded so that a
  change in the library can be compared against them, not as a promise.
- A hidden tab is throttled by the browser to about one timer a minute, which slows nothing in
  these scenarios — deliveries, writes and a lost worker are messages and Web Locks, not timers;
  see [Shared ports](shared-ports.md) for what throttling means.

## Running the benchmarks

```sh
npm run bench                                       # the simulated browser, about a second
SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser   # a real browser, about ten minutes
```

Both build the package first. The harness benchmark writes `bench/results/harness.json` and the
fragments under `docs/site/_generated/` that this chapter includes; the browser benchmark writes
`bench/results/browser.json` and its fragment. All of them are committed, so that this chapter
builds without a benchmark run and the numbers a reader sees are the numbers that were measured —
the header of each fragment names the commit and the machine, and says when the measured code had
uncommitted changes. The browser benchmark drives the installed Microsoft Edge, as the browser test
suite does; `SERIAL_BROKER_BROWSER_CHANNEL` picks another Chromium, and
`SERIAL_BROKER_BROWSER_TEST_PORT` moves its server off port 8147.
