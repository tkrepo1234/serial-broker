# Testing

The hard part of this library is not the Web Serial call — it is what happens when two tabs
race, the owner dies mid-write, and a device disappears in the same 50 ms. Those are the tests
that matter, and they must be **deterministic**.

## Levels

| Level               | Location                                             | What it proves                                                                                                                                                                      | Rule                                                                                                                                                    |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**            | `test/unit/`                                         | One module in isolation: backoff maths, validation, codecs, protocol encode/decode.                                                                                                 | No fakes beyond the module's own dependencies. Fast (< 5 ms each).                                                                                      |
| **Integration**     | `test/integration/`                                  | Several real modules against the simulated browser harness: a single tab end-to-end, reconnect, write queueing.                                                                     | Uses the harness, never the real DOM.                                                                                                                   |
| **Multi-context**   | `test/integration/multi-tab/`                        | The actual product claim: N simulated tabs sharing one port, ownership failover, broadcast fan-out, interlocking under contention.                                                  | Mandatory for every change to `owner/`, `worker/` or `client/`.                                                                                         |
| **Browser**         | `test/browser/`                                      | The **built** package in a real Chromium: a real `SharedWorker` handshake, real Web Locks, real `BroadcastChannel`, `dist/` loaded by a page.                                       | Scenarios only, no races; `npm run test:browser`. See below and ADR-0035.                                                                               |
| **Hardware**        | `test/browser/hardware/`                             | The same scenarios against a real serial device, through a real UART.                                                                                                               | Runs only with `SERIAL_BROKER_HARDWARE=arduino`, `=emulator` or `=picker`; results in `docs/manual-test-plan.md`.                                       |
| **Extreme**         | `test/integration/extreme/`, `test/browser/extreme/` | What the library costs and whether it stays stable at sizes no operator reaches: a hundred tabs, an hour of full-rate traffic, thousands of writes under crashes, a simulated week. | Runs only with `SERIAL_BROKER_EXTREME=1` (`npm run test:extreme`), never in CI; each part records its last run in a `RESULTS.md` next to it. See below. |
| **Emulated device** | `emulator/`                                          | Real Chromium and the real Windows serial stack against a USB device whose failures are scriptable.                                                                                 | Its own tests live in `emulator/test/`; a browser drives it in `test/browser/hardware/emulator.spec.ts`.                                                |
| **Manual**          | `debug/`                                             | Real Chromium, real hardware. Documented, checklisted, never a substitute for the above.                                                                                            | Recorded in `docs/manual-test-plan.md`.                                                                                                                 |
| **Benchmark**       | `bench/`                                             | What the library costs: latency, throughput, handover and start times, an hour's steady state; on the harness and in a real browser.                                                | Not a test: nothing gates on a number. `npm run bench`; see below and ADR-0037.                                                                         |

## Determinism is mandatory

No test may depend on wall-clock time, real timers, real randomness or real task ordering.

- **Time** is injected (`Clock`) and driven by the harness's `FakeClock`, which moves only when a
  test advances it. `harness.settle()` lets pending promise chains run without moving time. A test
  that calls `await sleep(100)` to "let things settle" is rejected in review. The fake keeps the two
  readings apart, as a browser does (ADR-0014): `jumpWallClock()` sets the system time without
  touching a timer, and `stall()` lets monotonic time pass without running one, which is how a
  frozen or throttled tab's late timers are tested.
- **Randomness** is injected. The harness draws the top of the jitter range every time, so backoff
  schedules are asserted exactly.
- **IDs** come from an injected generator, so they are predictable within a test.
- **Task ordering** in the multi-tab harness is explicit. Messages are delivered asynchronously and
  structurally cloned, as `postMessage` delivers them, and an interleaving is _chosen_ by where a
  test settles, holds a tab's incoming messages back (`openBusyTab()`), kills a tab or crashes the
  worker — not hoped for.
- **A setup is not a connection.** `SerialBrokerClient.setup()` returns before the port opens;
  `VirtualTab.setup()` settles for you. A test that emits data or asserts that something was _not_
  delivered straight after `client.setup()` passes for the wrong reason. Every negative assertion
  needs a positive control showing that the event did happen somewhere.

A flaky test is treated as a failing test and is fixed or deleted within the same change.
Never retried, never `.skip`ped with a TODO.

## The simulated browser harness

`test/harness/` provides in-memory implementations with the _documented_ semantics of:

- `navigator.serial` — per-origin permission and `getPorts` persistence, a picker that honours
  the request's filters, `connect`/`disconnect` events, one `SerialPort` object per context, and
  devices whose opens and writes can be made to fail or hang and whose read stream can error or
  end. User activation is not modelled.
- `navigator.locks` — exclusive and shared mode: FIFO queueing, `ifAvailable`, `signal`, `query()`,
  and automatic release on context death. A shared lock is granted to any number of holders while
  no exclusive one is held, as the library needs it for watching a term of holding the port
  (`src/client/owner-terms.ts`) and for keeping a remembered configuration while a tab runs it
  (`src/storage/persistence-hold.ts`). `steal` is not modelled, and the library does not use it.
- `SharedWorker` / `MessagePort` — the real broker behind a message graph between simulated
  contexts, with the ability to kill a context abruptly, crash the worker, or have its script
  fail to load or run another protocol version.
- `BroadcastChannel`, and a `localStorage` that can be made unavailable.

The harness is the most important asset in the test suite. It has its own tests
(`test/harness/harness-conformance.test.ts`) proving it matches the specified browser behaviour —
**a fake that lies produces tests that lie.**

## The browser suite

`npm run test:browser` builds the package and runs `test/browser/` against a real Chromium with
Playwright (ADR-0035). Locally it drives the **installed Microsoft Edge**, so nothing is
downloaded; CI installs Chromium and runs the same suite. A static server serves `dist/` and the
test pages from `test/browser/pages/`, and each test opens ordinary pages that `import` the
library — one page is one tab.

What belongs here is what **only a browser can answer**: that a Web Lock is released when a
renderer dies, that one `SharedWorker` serves the tabs of an origin, that the built files find
each other, that the minified entry point coordinates with the readable one. What does **not**
belong here is a race: an interleaving a browser produces by luck is a flaky test, and
`test/integration/multi-tab/` stages the same interleaving on purpose. The browser suite has no
coverage gates and nothing in it is retried.

Web Serial itself is replaced, per page, before the page's scripts run
(`test/browser/stand-in/web-serial-stand-in.ts`): permission per origin, one page at a time
holding the device, a loopback for a device. Two things about it are worth knowing before
changing it:

- It is serialised into the page, so it may use no `#private` fields — the test runner's transform
  rewrites them into helpers that do not travel with the source, and the page then throws before
  `navigator.serial` is replaced.
- Every script an automation evaluates carries transient activation, so `USER_GESTURE_REQUIRED`
  cannot be produced in a browser test. It stays covered in-process.

Two things a page cannot see about a `SharedWorker` — how many of them exist, and when one dies —
come from Chromium's target list over CDP (`sharedWorkersOf`, `terminateSharedWorkers` in
`test/browser/support/tab.ts`): the same list `chrome://inspect/#workers` shows. Terminate the
worker with it rather than crashing a renderer and assuming the worker lived there; Chromium may
host it in a client's process or in one of its own, and a test that assumes either fails minutes
later for a reason that is not the library's.

### Against real hardware

`test/browser/hardware/` runs the same scenarios against a device that answers. It is skipped
unless `SERIAL_BROKER_HARDWARE` names the target (`arduino`, `emulator` or `picker`), it never runs in CI, and it **works on Windows
only**: the permission is seeded as a Windows device instance ID, read with
`Get-CimInstance Win32_PnPEntity`, and elsewhere no port is found.

```sh
SERIAL_BROKER_HARDWARE=arduino npm run test:browser -- test/browser/hardware
```

```powershell
$env:SERIAL_BROKER_HARDWARE='arduino'; npm run test:browser -- test/browser/hardware
```

It needs an Arduino (USB `0x2341`/`0x0078`) on a COM port running a sketch that echoes every byte
at 9600 baud, and nothing else using that port. The browser is given the permission through a
throwaway profile written before it starts — no prompt is answered and no machine-wide setting is
touched. `SERIAL_BROKER_HARDWARE_PORT` picks the port when several boards are attached. The
documented command runs six tests. No large payload is among them: a payload beyond one write chunk
is the emulator's, below, which takes 64 KiB of every byte value in minutes and counts what reached
the device. The board echoes at about 80 bytes a second and, without flow control, loses what
arrives faster than its sketch reads - which says something about the board and nothing about the
library.

`SERIAL_BROKER_HARDWARE=emulator` runs `emulator.spec.ts` instead, against the
[USB/IP emulator](../../emulator/README.md). The spec starts the emulator itself, lets usbip-win2
attach it and drives it through its terminal, so it covers what a board on a cable cannot be made
to do on cue: unplugged and plugged in again, hung mid-write, answering one byte per read, and an
owner killed while its write is held at the device. It counts the bytes that reached the device
rather than inferring them from the echo. It needs usbip-win2 (`SERIAL_BROKER_USBIP` points at
`usbip.exe` if it is not in `C:\Program Files\USBip`) and nothing else listening on port 3240.

`SERIAL_BROKER_HARDWARE=picker` runs `picker.spec.ts`: the first connection through Chromium's
own port picker, against the Arduino, with a profile that has never been given the device. The
picker is browser UI that neither a page nor the DevTools protocol can reach, so
`support/port-picker.ps1` answers it through Windows UI Automation - it finds the picker by the
origin in its name and its buttons by their position, never by a label in the browser's language.
It needs a desktop, because a headless browser has no picker to show.

`npm run test:background` (`test/browser/background-tab.mjs`) is the one browser run that does not
use Playwright: Playwright keeps every page it drives visible and unthrottled, so a tab in the
background cannot be had with it. The script starts a browser with a window, drives it over the
DevTools protocol alone, and checks that the tab holding the port, hidden and throttled, still
serves the others. `SERIAL_BROKER_BACKGROUND_SECONDS=330` keeps it hidden past the five minutes
after which Chromium lets a hidden page's timers run once a minute. Opt-in, like the hardware runs.

**Record every hardware run in [the manual test plan](../manual-test-plan.md)** — date, browser
version, device, result.

## The benchmarks

`bench/` measures what the library costs, in two places, against expectations written down
before anything is measured (`bench/expectations.ts`, ADR-0037). The results are the
[Performance chapter](../site/performance.md) of the documentation.

```sh
npm run bench                                       # the harness scenarios, about a second
SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser   # the same in a real browser, minutes
```

```powershell
$env:SERIAL_BROKER_BENCH_BROWSER='1'; npm run bench:browser
```

The harness benchmark runs the production classes on `test/harness/` and reports the library's own
cost: percentiles of wall-clock time over many samples, plus what the fake clock can say exactly -
simulated time, timers scheduled. The browser benchmark runs the built package in the installed
Edge with the Web Serial stand-in, on port 8147 (`SERIAL_BROKER_BROWSER_TEST_PORT` moves it), and
never in CI: its numbers depend on the machine and are recorded once, with the machine named.

Both write `bench/results/*.json` and the fragments under `docs/site/_generated/` that the chapter
includes; **commit what they wrote**. A result more than ten times worse than its expectation is
printed at the end, and has to become either a fix in `src/` with a regression test or a limit
recorded in the chapter - never an adjusted expectation.

A benchmark is not a test. It reads the wall clock, which a test may not; it asserts only that it
did what it measures; and no number in it fails a build. A change to `src/client/`, `src/worker/`
or `src/owner/` that is meant to be faster shows in a diff of `bench/results/harness.json`.

## The extreme suite

The ordinary suites prove behaviour. The extreme suite measures **cost and stability** at sizes an
operator's screen never reaches, and asserts bounds on both. It is opt-in — `SERIAL_BROKER_EXTREME=1`,
which `npm run test:extreme` sets — because a run takes minutes and asks for a heap the ordinary
suite does not; it never runs in CI. Every scenario file is `describe.skipIf`, so `npm test` and
the coverage run see the files and skip them.

```sh
npm run test:extreme                          # every scenario, both transports
npm run test:extreme -- sustained-traffic     # one scenario file
SERIAL_BROKER_EXTREME_TABS=1000 npm run test:extreme -- many-tabs
```

The in-process part, `test/integration/extreme/`, runs on the simulated browser with
`--expose-gc`, which the script sets: memory is read after a full garbage collection, and the
support refuses to measure without one. Its scenarios, each on both transports:

| Scenario               | What it does                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `many-tabs`            | 100 tabs on one configuration; the tab holding the port closed ten times among them; 20 configurations shared by 10 tabs each, with no cross-talk.        |
| `long-lived-owner`     | 50 000 writes accepted by one tab in one term of holding the port: the record of accepted writes stays within its bound.                                  |
| `sustained-traffic`    | A simulated hour at 115 200 baud in chunks of 255 bytes - 41 MB, 162 000 chunks - to 10 tabs with text decoding on, characters split by chunk boundaries. |
| `writes-under-crashes` | 10 000 writes from 20 tabs, the tab holding the port killed every 100 writes with the batch at its port; at-most-once checked from the device's side.     |
| `largest-payloads`     | 16 MiB payloads back to back from a tab that does not hold the port, then as many at once as the port keeps waiting.                                      |
| `setup-release-churn`  | 1 000 setup and release cycles in two tabs taking turns holding the port.                                                                                 |
| `simulated-week`       | 10 tabs through 7 simulated idle days, with a chunk and a write an hour.                                                                                  |
| `freezing-under-load`  | Half of 10 tabs frozen for a minute of full-rate traffic with a write on its way, resumed timers-first or tasks-first; every chunk in order.              |
| `observer-watchers`    | A diagnostics observer with 1 000 watchers under traffic, then stopped.                                                                                   |

Every scenario measures the same **footprint** before and after its load (`support/extreme.ts`):
heap and `ArrayBuffer` memory after a collection, timers on the library's clock and on the bus's,
device listeners, application listeners, Web Locks held and pending, writes pending and queued at
the port, participants the worker knows, and messages sent and delivered on the wire - handshakes
included, counted by `FakeBus.meter`. The bounds are that every count is the same before and after,
memory grows by no more than a few MiB, the messages stay within the scenario's **budget** - a
formula of its load, written next to it, that an amplification would cross (the bus is
deterministic, so the counts are the same on every run) - and, at the very end, **every tab still works**: a chunk
reaches all of them and a write from the last of them reaches the device once. The sizes are
`SIZES` in `support/extreme.ts`, each with a `SERIAL_BROKER_EXTREME_*` variable; the defaults keep a
full run under a minute of measured load on a development machine, so a longer run is a variable
away.

Two things the simulated browser cannot do shape these scenarios. A killed tab's JavaScript runs
on - only its timers, its messages and its locks stop - so the fake port refuses a write of a port
the browser closed, and a scenario sets aside the writes the killed tab itself had outstanding:
in a browser nobody is left to settle them. And the fake clock refuses more than ten thousand
timers in one step, so a simulated week advances an hour at a time.

A memory bound measures the harness as much as the library, so the harness keeps nothing of a tab
that closed or was killed: its ports, listeners and bus connections are let go of, which
`harness-conformance.test.ts` proves with a `WeakRef` and a collection. What the worker itself keeps
of a killed tab is let go as soon as the browser lets go of the tab's lock (ADR-0041). Some state the library keeps is visible to no
count - the record of writes accepted at the port, for one - and is bounded through the heap alone:
`long-lived-owner` fails when that record is unbounded.

`npm run test:extreme` writes the run's numbers to `test/integration/extreme/RESULTS.md`, which is
committed as the record of the last run; a diff of it is the drift.

The real-browser part, `test/browser/extreme/`, is one Playwright scenario, skipped unless
`SERIAL_BROKER_EXTREME=1`: twenty pages on one origin share the stand-in device for five minutes
of loopback traffic, the page holding the port is closed every 30 seconds and replaced, and the
heap, DOM nodes and event listeners of every page are read over CDP (`Performance.getMetrics`,
after `HeapProfiler.collectGarbage`) at the start, the middle and the end - and the heap of the
`SharedWorker` too, through `Runtime.getHeapUsage`, since a worker answers no `Performance` domain.
The bound is a few MiB of heap and a handful of nodes and
listeners from a page's first reading to its last, and every page still receives at the end.
It writes `test/browser/extreme/RESULTS.md`. Run it alone, with one worker:

```sh
SERIAL_BROKER_EXTREME=1 npm run test:browser -- test/browser/extreme --workers=1
```

```powershell
$env:SERIAL_BROKER_EXTREME='1'; npm run test:browser -- test/browser/extreme --workers=1
```

What these runs find is handled like any other finding: a leak or a bound that does not hold is
fixed in `src/` with a regression test in the ordinary suite, and a limit that cannot be lifted is
documented in [How shared ports behave](../site/shared-ports.md).

## Writing tests

- Name: `describe('<unit>', ...)` / `it('<asserts the observable behaviour>', ...)`.
  `it('works')` is rejected. `it('promotes the longest-waiting tab when the owning tab is
killed mid-write')` is the standard.
- **Arrange / Act / Assert**, separated by blank lines, in that order.
- Assert on **observable behaviour** — public API results, emitted events, bytes that reached
  the device — never on private fields. A test that reaches into `#state` documents an
  implementation, not a contract.
- One logical assertion per test. Multiple `expect` calls proving one fact are fine.
- Every bug fix starts with a failing regression test that names the issue.

## Coverage gates

Enforced in CI; the build fails below them.

| Metric     | Global | `src/worker/` | `src/client/` | `src/owner/` |
| ---------- | ------ | ------------- | ------------- | ------------ |
| Statements | 90%    | 95%           | 94%           | 88%          |
| Branches   | 85%    | 85%           | 80%           | 70%          |
| Functions  | 90%    | 95%           | 95%           | 82%          |
| Lines      | 90%    | 95%           | 94%           | 88%          |

The **branch** bars of `src/client/` and `src/owner/` are lower than the global one, which looks backwards
and is not. Those modules are dense with guards against races that cannot be produced on
demand - "the configuration was released while this message was in flight", "ownership moved
between the send and the delivery". Each guard is correct, cheap, and load-bearing; but
staging one from a test would mean reaching into private state to arrange an interleaving the
public API cannot express, and a test that does that asserts an implementation rather than a
contract.

The honest statement is therefore: those branches are reviewed, not covered. Raising the
number by writing tests that reach into private fields would make the suite worse, not better.

**Coverage is a floor, not a goal.** 100% coverage of the happy path with no failover test is
a failing test suite regardless of what the number says. The scenario matrix below is the
actual bar.

## Mandatory scenario matrix

Every release must have a green test for each of these. New scenarios are appended, never
removed:

1. Single tab: setup → permission already granted → open → send → receive.
2. Single tab: setup with no permission → `awaiting-permission` → `requestAccess` → open.
3. Two tabs: second tab attaches to an already-open configuration and receives broadcasts.
4. Two tabs: a tab that does not own the port sends; bytes reach the device exactly once;
   both tabs see `onSend`.
5. The owning tab closes gracefully → another tab takes ownership and reopens the port.
6. The owning tab is killed abruptly (no unload handler) → failover still happens, via the
   browser releasing its lock.
7. The owner dies **while a write is in flight** → the write either completes or fails with a
   definite, reported error. Never silently lost, never applied twice.
8. Device unplugged → status `reconnecting` in all tabs → replugged → reopened automatically
   with the persisted settings, with no application action.
9. Device unplugged permanently → backoff grows to the configured ceiling and stops at
   `maxAttempts`, with a terminal error reported once per tab.
10. Reload of all tabs → settings restored from storage → port reopened without a new prompt.
11. Two configurations, two devices, in the same tabs → no cross-talk in either direction.
12. Malformed/foreign message on the shared channel → dropped, warned, no state change.
13. Protocol-version mismatch between two tabs → they refuse to federate, both report it.
14. A listener throws → other listeners still receive the event, error reported once.
15. `send()` with a payload larger than the device buffer → chunked, ordered, complete.
16. Rapid `setup`/`release` churn → no leaked locks, timers, workers or listeners.
