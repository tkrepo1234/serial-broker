# Performance

What serial-broker costs, measured: how fast bytes reach every tab, how long a write from a tab
takes to reach the device, how long a handover and a start take, and whether an hour of traffic
leaves anything behind. Every number stands next to the value it was expected to have, and the
expectation was written down before the first measurement.

On a production line the serial line itself is the limit. At 9600 baud a device produces about a
kilobyte a second; at 921 600 baud, about 90 KB/s. The library's own cost has to stay far below
that in every scenario, and it does; the numbers below say by how much.

## What is measured, and where

The same scenarios are measured in two places, and the two tables below are meant to be read side
by side.

- **The simulated browser** (`bench/harness/`): the library's production classes on the test
  suite's harness - a fake bus carrying the real broker, a fake serial registry, fake locks, and a
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

| Scenario                        | What is measured                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `device-to-tabs/1`, `5`, `10`   | The device pushes 255-byte chunks (the default read buffer). Latency from the push to `onReceive` in each tab, one chunk at a time; throughput from a burst of 2000 chunks. |
| `tabs-to-device/<n>-per-second` | A tab that does not hold the port sends a six-byte write every second, ten times a second, a hundred times a second. Latency from `send()` to its promise settling.         |
| `tabs-to-device/1-mb-write`     | One `send()` of 1 MiB from that tab, to its promise settling, with the default 4 KiB write chunk.                                                                           |
| `handover/crash`                | The tab holding the port is killed with no chance to clean up. Time until another tab reports `open`.                                                                       |
| `handover/release`              | The tab holding the port releases the configuration. Time until another tab reports `open`.                                                                                 |
| `start/first-tab`               | A fresh browser with the device granted: from `setup()` to `open`.                                                                                                          |
| `start/joining-tab`             | A tab joining a configuration another tab already holds open: from `setup()` to `open`.                                                                                     |
| `steady-state/one-hour`         | Three tabs, one chunk and one write a second for an hour. Heap growth, and - in the harness - timers still scheduled, compared after a minute of warm-up and at the end.    |

Every scenario runs over both transports: the `SharedWorker` broker, and the `BroadcastChannel`
fallback.

Two numbers in the harness table are not wall-clock time. **Simulated** time is how far the fake
clock moved: `0 ms` says that a handover or a start waited on no timer at all - the successor
opens the port as soon as the browser hands it the lock, and nothing in between is a delay the
library chose. **Timers** are the harness's count of scheduled timers, which the browser cannot
report; a difference would be a timer the library scheduled and never cleared.

The wall-clock numbers are percentiles over many samples - 500 chunks per tab, 60 to 500 writes,
20 fresh harnesses for a handover or a start - because they vary with the machine and with what
else it is doing. A run says which machine it was made on. One tab in `device-to-tabs/1` is the
tab holding the port, so that row measures the holder's own read loop and dispatch, with no bus
hop; the hops begin with the second tab.

## The expectations

The expectations are data in `bench/expectations.ts`, one set for each place, and the reasoning
for each number is in a comment next to it. They were written before anything was measured, and
they are not adjusted to a result: the rule (BACKLOG.md, "Performance") is that a result more than
ten times worse than its expectation becomes either a fix in the library, with a test, or a limit
written down in this chapter. A result that is far better than expected is left as it is; the
expectation stays what it was.

For the harness, the expectations follow from what a hop costs: a structured clone of a few
hundred bytes and a validation, tens of microseconds each. A chunk to one tab is two clones and a
validation, so 0.1 ms at the median and 2 MB/s in a burst; every further tab adds one clone and
one validation. A write from a tab that does not hold the port makes four hops. Handovers and
starts wait on no timer, so they should take no simulated time and a couple of milliseconds of
wall clock. After an hour, the heap should be within half a megabyte of where it started, with
the same timers scheduled.

For the browser, every hop is a real `postMessage` between processes at a few hundred
microseconds, so the latencies are ten times the harness's; a handover after a crash waits for
Chromium to notice that the renderer is gone, so a quarter of a second; and the megabyte is
echoed back by the stand-in in 255-byte pieces, four thousand of them, which is the expensive
part of that scenario.

## The simulated browser

```{include} _generated/harness-benchmark.md

```

## A real browser

Recorded once, on the machine named below, with the Web Serial stand-in of the browser test
suite (`test/browser/stand-in/web-serial-stand-in.ts`) standing in for the device - a loopback
that can also be made to push bytes of its own. The rates are real time here, the simulated hour
is its volume of traffic as fast as the pages take it, and the heap is read through the DevTools
protocol after a forced garbage collection; the browser's timers cannot be observed from outside.
A handover after a crash is timed from the moment the test runner orders the crash, so that
number includes the DevTools round trip.

```{include} _generated/browser-benchmark.md

```

## Build sizes

What an application installs, as built and gzipped, from `scripts/check-dist.mjs`, which prints
these after every build so that CI reports them on every run. There is no size budget: the sizes
are reported, not enforced (decided 2026-09-14). The worker script is served next to the
application whatever the entry point, so it is part of every installation.

```{include} _generated/build-sizes.md

```

## Results worse than expected

Nothing in either run is more than ten times worse than its expectation, so the first measurement
leaves neither a fix nor a documented limit to record. Three things in the numbers are worth
knowing all the same:

- **A handover after a crash is the one result over its expectation**: 640 ms at the median on
  the `SharedWorker` transport and 345 ms on `BroadcastChannel`, against the 250 ms expected, with
  a 95th percentile around 850 ms on both. The library does nothing in that time. The lock is
  released by the browser once the renderer's process is gone, and the successor opens the port
  at once - the harness shows that path at a tenth of a millisecond with no simulated time. The
  number is Chromium's time to notice a dead renderer plus the DevTools round trip that orders the
  crash, and a tab killed by the operating system is noticed the same way. It stays a platform
  number, not a limit of the library, and the expectation stays at 250 ms so that the next run is
  judged against the same line.
- **The browser's sub-millisecond rows are coarse.** `performance.now()` in a page that is not
  cross-origin isolated has a resolution of 100 µs, so a latency of `0.100 ms` means "under 200
  µs", and the one-tab rows, where the holder delivers to itself, sit at the resolution floor.
- **The megabyte write is not dominated by the echo after all**: the write's promise settles in
  about 20 ms, well before the stand-in has echoed the megabyte back, so the expectation of two
  seconds, which reasoned from the echo, was wrong in the safe direction. Against a real device
  the write itself takes as long as the line rate says - about eighteen minutes at 9600 baud -
  and the library's part of it is the harness number.

The harness numbers came in between ten and a hundred times under their expectations, which
reasoned from tens of microseconds a hop where the process spends a few. The expectations stand
as written; a result is compared with them, not with the last run.

Anything that changes this section - a result that crosses the line, a fix, a limit - is recorded
here with the run that found it.

## What the numbers do not say

- They say nothing about a real serial line. A device at 9600 baud produces 960 bytes a second,
  and every scenario above is far faster than any line the library will meet; the throughput
  rows say how much headroom there is, not how fast a device can be read.
- The browser numbers are one machine, one browser version, one day. They are recorded so that a
  change in the library can be compared against them, not as a promise.
- A hidden tab is throttled by the browser to about one timer a minute, which slows nothing in
  these scenarios - deliveries and writes are messages, not timers - but delays a heartbeat; see
  [Shared ports](shared-ports.md) for what that means.

## Running the benchmarks

```sh
npm run bench                                       # the simulated browser, about a second
SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser   # a real browser, several minutes
```

Both build the package first. The harness benchmark writes `bench/results/harness.json` and the
fragments under `docs/site/_generated/` that this chapter includes; the browser benchmark writes
`bench/results/browser.json` and its fragment. All of them are committed, so that this chapter
builds without a benchmark run and the numbers a reader sees are the numbers that were measured -
the header of each fragment names the commit and the machine. The browser benchmark drives the
installed Microsoft Edge, as the browser test suite does; `SERIAL_BROKER_BROWSER_CHANNEL` picks
another Chromium, and `SERIAL_BROKER_BROWSER_TEST_PORT` moves its server off port 8147.
