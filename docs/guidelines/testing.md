# Testing

The hard part of this library is not the Web Serial call — it is what happens when two tabs
race, a master dies mid-write, and a device disappears in the same 50 ms. Those are the tests
that matter, and they must be **deterministic**.

## Levels

| Level             | Location                      | What it proves                                                                                                                  | Rule                                                               |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Unit**          | `test/unit/`                  | One module in isolation: backoff maths, validation, codecs, protocol encode/decode.                                             | No fakes beyond the module's own dependencies. Fast (< 5 ms each). |
| **Integration**   | `test/integration/`           | Several real modules against the simulated browser harness: a single tab end-to-end, reconnect, write queueing.                 | Uses the harness, never the real DOM.                              |
| **Multi-context** | `test/integration/multi-tab/` | The actual product claim: N simulated tabs sharing one port, master failover, broadcast fan-out, interlocking under contention. | Mandatory for every change to `master/`, `worker/` or `client/`.   |
| **Type**          | `test/types/`                 | The public surface type-checks as documented and rejects misuse.                                                                | `expectTypeOf` assertions; failures are compile errors.            |
| **Manual**        | `examples/demo/`              | Real Chromium, real hardware. Documented, checklisted, never a substitute for the above.                                        | Recorded in `docs/manual-test-plan.md`.                            |

## Determinism is mandatory

No test may depend on wall-clock time, real timers, real randomness or real task ordering.

- **Time** is injected (`Clock`) and controlled with Vitest's fake timers. A test that calls
  `await sleep(100)` to "let things settle" is rejected in review.
- **Randomness** is injected. Reconnect jitter is seeded, so backoff schedules are asserted
  exactly.
- **IDs** come from an injected generator, so assertions can name `client-1`, `request-3`.
- **Task ordering** in the multi-tab harness is explicit: the harness has a message pump that
  the test advances step-by-step, so interleavings are _chosen_, not hoped for.

A flaky test is treated as a failing test and is fixed or deleted within the same change.
Never retried, never `.skip`ped with a TODO.

## The simulated browser harness

`test/harness/` provides in-memory implementations with the _documented_ semantics of:

- `navigator.serial` — including `requestPort` gesture rules, `getPorts` persistence,
  `connect`/`disconnect` events, and a `SerialPort` whose streams can be made to stall,
  error, or vanish mid-write.
- `navigator.locks` — full Web Locks semantics: exclusive/shared modes, FIFO queueing,
  `ifAvailable`, `steal`, `signal`, and automatic release on context death.
- `SharedWorker` / `MessagePort` — a real bidirectional message graph between simulated
  contexts, with controllable delivery ordering and the ability to kill a context abruptly.
- `BroadcastChannel`, `localStorage`.

The harness is the most important asset in the test suite. It has its own tests
(`test/harness/*.test.ts`) proving it matches the specified browser behaviour — **a fake that
lies produces tests that lie.**

## Writing tests

- Name: `describe('<unit>', ...)` / `it('<asserts the observable behaviour>', ...)`.
  `it('works')` is rejected. `it('promotes the longest-waiting tab when the master tab is
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
| Lines      | 90%    | 95%           | 94%           | 90%          |

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
4. Two tabs: non-master sends; bytes reach the device exactly once; both tabs see `onSend`.
5. Master tab closes gracefully → the other tab becomes master and reopens the port.
6. Master tab is killed abruptly (no unload handler) → failover still happens via lock release.
7. Master dies **while a write is in flight** → the write either completes or fails with a
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
