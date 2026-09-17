# ADR-0014: Inject the browser environment, with a monotonic and a wall clock

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

The behaviour worth testing is the interaction of five platform APIs under adversarial timing:
Web Serial, Web Locks, SharedWorker/MessagePort, BroadcastChannel and localStorage.
Real browsers cannot be made to kill a tab between two specific statements, stall a
`writer.write()` forever, or release a lock at a chosen instruction boundary. Module-level
mocking does not help either, because the code under test would still reach for a global and
the test could not run two independent tabs in one process.

Time is part of the environment too, in two senses. `Date.now()` jumps whenever the user corrects
the clock, a laptop crosses a time zone, or NTP steps it; a jump of an hour is ordinary on a machine
that has just woken. A duration computed from two such readings is wrong by the size of the jump,
while the browser's timers, which run on a monotonic clock, are not: a connection open for hours
looked unstable after the clock was set back, and waiting writes expired the moment it was set
forward.

The platform's own Web Serial types are _ambient_, declared globally by `@types/w3c-web-serial`, a
package this library cannot make an application install.

## Decision

All platform access goes through a single injected `SerialBrokerEnvironment`:

    interface SerialBrokerEnvironment {
      readonly serial: SerialLike;                  // navigator.serial
      readonly locks: LockManagerLike;              // navigator.locks
      readonly storage: KeyValueStorage;            // localStorage
      readonly createTransport: (request) => Transport;
      readonly createBroadcastChannel?: BroadcastChannelFactory; // the version announcement
      readonly clock: Clock;                        // now(), monotonicNow(), setTimer, clearTimer
      readonly random: () => number;                // backoff jitter
      readonly newId: IdGenerator;                  // client, term and request identifiers
      readonly logger: ScopedLogger;
      readonly logPayloads: boolean;
    }

No module outside the two composition roots - `src/environment/browser.ts` and the worker's entry
point, `src/worker/serial-broker.worker.ts` - references `navigator`, `window`,
`localStorage` or the timer functions; `no-restricted-globals` enforces it. Time and randomness come
from the environment as well. The test environment is plain Node with no browser globals, so a
violation fails loudly rather than silently working in production.

**Two clocks.** `Clock.now()` is epoch milliseconds (`Date.now()`), for every moment that leaves the
tab: an error's `timestamp`, an event's time, `since`, `openedAt`, `nextAttemptAt`, `collectedAt`.
`Clock.monotonicNow()` is `performance.now()`, for every duration: the stability window of the
backoff, the expiry of a waiting write, the lateness of a deadline, the rate limits. The rule: a
number that is subtracted from another is monotonic; a number that is shown or sent is the wall
clock. A monotonic reading appears in no message, record or report, and is never compared across
contexts.

**Narrowed types.** `src/environment/environment.ts` declares `SerialLike`, `SerialPortLike`,
`SerialOptionsLike`, `SerialPortInfoLike`, `SerialPortRequestOptionsLike` and
`SerialPortFilterLike`, and nothing in `src/` names an ambient Web Serial type. The platform's
objects satisfy them structurally. `scripts/check-dist.mjs` type-checks every emitted `.d.ts` with
`skipLibCheck: false` and no ambient types, so a Web Serial type creeping back fails the build.

The public facade builds the default environment lazily, so applications see none of this;
`SerialBroker` is still a zero-argument singleton. Tests construct
`new SerialBrokerClient(environment)` directly - which is also what lets one test process run
a dozen independent simulated tabs.

## Alternatives considered

- **Global mocking with `vi.stubGlobal`.** One global set per process means no multi-tab test,
  which is the entire point of this library. Fatal.
- **Testing only against real Chromium via Playwright.** Cannot produce the failure interleavings
  that matter. Retained as a layer on top ([ADR-0035](./0035-browser-tests-with-playwright.md)).
- **Injecting each dependency separately into each class.** The parameter lists grow without bound
  and every new dependency becomes a mechanical refactor. One environment object is simpler.
- **One clock reading, clamping negative differences.** Hides half the problem: a clock set forward
  still expires writes and resets backoff early, and a wrong measurement becomes a plausible one.
- **A monotonic `now()`, with timestamps derived from it.** Errors and events would carry numbers
  that mean nothing outside the tab, and no support case could be matched against an application's
  log.
- **Measure durations by counting timers.** Timers are what runs late in a throttled or frozen tab,
  which is what deadlines have to detect.
- **Ship the ambient Web Serial types, or tell applications to install them.** They would collide
  with an application's own copy, and a transport wrapper must not dictate a types version.

## Consequences

### Positive

- Multi-tab scenarios are ordinary tests: fast, deterministic, and able to express interleavings
  that are otherwise impossible to trigger.
- The set of platform APIs the library depends on is visible in one interface.
- Setting the system clock changes nothing about reconnect behaviour or write expiry, and a
  duration and the timer waiting for it agree by construction.
- Nothing this package publishes needs `@types/w3c-web-serial`.

### Negative

- The environment object is threaded through the internals, and the fakes must be faithful.
  Mitigated by conformance tests on the harness itself.
- Two readings of "the time" are two chances to pick the wrong one. The names and the TSDoc are the
  mitigation; a duration measured with `now()` is a review finding.
- Whether a machine's sleep counts towards `performance.now()` differs between platforms, as for
  timers; both are affected alike.

## Verification

The lint rule fails the build on direct global access outside the composition roots; the harness
has its own conformance suite (`test/harness/harness-conformance.test.ts`, including
`FakeClock.monotonicNow()` ignoring `jumpWallClock`). `test/integration/reconnect.test.ts` ("a
system clock that is set"), `test/integration/multi-tab/browser-lifecycle.test.ts` and
`test/unit/pending-writes.test.ts` (`scheduleDeadline`) hold durations to the monotonic clock. `scripts/check-dist.mjs` type-checks the published declarations.
