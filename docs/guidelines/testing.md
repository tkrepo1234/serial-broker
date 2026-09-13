# Testing

The hard part of this library is not the Web Serial call — it is what happens when two tabs
race, the owner dies mid-write, and a device disappears in the same 50 ms. Those are the tests
that matter, and they must be **deterministic**.

## Levels

| Level               | Location                      | What it proves                                                                                                                     | Rule                                                                                     |
| ------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Unit**            | `test/unit/`                  | One module in isolation: backoff maths, validation, codecs, protocol encode/decode.                                                | No fakes beyond the module's own dependencies. Fast (< 5 ms each).                       |
| **Integration**     | `test/integration/`           | Several real modules against the simulated browser harness: a single tab end-to-end, reconnect, write queueing.                    | Uses the harness, never the real DOM.                                                    |
| **Multi-context**   | `test/integration/multi-tab/` | The actual product claim: N simulated tabs sharing one port, ownership failover, broadcast fan-out, interlocking under contention. | Mandatory for every change to `owner/`, `worker/` or `client/`.                          |
| **Emulated device** | `emulator/`                   | Real Chromium and the real Windows serial stack against a USB device whose failures are scriptable.                                | Its own tests live in `emulator/test/`; runs are recorded in `docs/manual-test-plan.md`. |
| **Manual**          | `debug/`                      | Real Chromium, real hardware. Documented, checklisted, never a substitute for the above.                                           | Recorded in `docs/manual-test-plan.md`.                                                  |

## Determinism is mandatory

No test may depend on wall-clock time, real timers, real randomness or real task ordering.

- **Time** is injected (`Clock`) and driven by the harness's `FakeClock`, which moves only when a
  test advances it. `harness.settle()` lets pending promise chains run without moving time. A test
  that calls `await sleep(100)` to "let things settle" is rejected in review.
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
- `navigator.locks` — exclusive mode: FIFO queueing, `ifAvailable`, `signal`, `query()`, and
  automatic release on context death. Shared mode and `steal` are not modelled, and the library
  uses neither; a shared request is refused rather than granted as if it were exclusive.
- `SharedWorker` / `MessagePort` — the real broker behind a message graph between simulated
  contexts, with the ability to kill a context abruptly, crash the worker, or have its script
  fail to load or run another protocol version.
- `BroadcastChannel`, and a `localStorage` that can be made unavailable.

The harness is the most important asset in the test suite. It has its own tests
(`test/harness/harness-conformance.test.ts`) proving it matches the specified browser behaviour —
**a fake that lies produces tests that lie.**

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

The coordination layer's **branch** bars are lower than the global one, which looks backwards
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
