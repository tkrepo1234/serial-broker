# ADR-0014: Inject the browser environment for testability

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

The behaviour worth testing is the interaction of five platform APIs under adversarial timing:
Web Serial, Web Locks, SharedWorker/MessagePort, BroadcastChannel and localStorage.
Real browsers cannot be made to kill a tab between two specific statements, stall a
`writer.write()` forever, or release a lock at a chosen instruction boundary. Module-level
mocking does not help either, because the code under test would still reach for a global and
the test could not run two independent tabs in one process.

## Decision

All platform access goes through a single injected `SerialBrokerEnvironment`:

    interface SerialBrokerEnvironment {
      readonly serial: SerialLike;        // navigator.serial
      readonly locks: LockManagerLike;    // navigator.locks
      readonly storage: KeyValueStorage;  // localStorage
      readonly createTransport: TransportFactory;
      readonly clock: Clock;              // now(), setTimeout, clearTimeout
      readonly random: () => number;      // for backoff jitter
      readonly newId: IdGenerator;        // client and request identifiers
      readonly logger: Logger;
    }

No module in `src/` references `navigator`, `window`, `self`, `Date`, `Math.random`,
`setTimeout` or `localStorage` directly. A lint rule (`no-restricted-globals`) enforces this,
and the test environment is plain Node with no browser globals, so a violation fails loudly
rather than silently working in production and lying in tests.

The default environment is constructed in exactly one place, `src/environment/browser.ts`,
which is the only file permitted to touch globals and is exempted by an explicit, commented
lint disable.

The public facade builds the default environment lazily, so applications see none of this;
`SerialBroker` is still a zero-argument singleton. Tests construct
`new SerialBrokerClient(environment)` directly - which is also what lets one test process run
a dozen independent simulated tabs.

## Alternatives considered

- **Global mocking with `vi.stubGlobal`.** One global set per process means no multi-tab test,
  which is the entire point of this library. Fatal.
- **Testing only against real Chromium via Playwright.** Cannot produce the failure
  interleavings that matter. Retained as a manual pre-release layer, not as the mechanism.
- **Injecting each dependency separately into each class.** More precise, but the parameter
  lists grow without bound and every new dependency becomes a mechanical refactor across
  every constructor. One cohesive environment object is the KISS choice.

## Consequences

### Positive

- Multi-tab scenarios are ordinary unit tests: fast, deterministic, and able to express
  interleavings that are otherwise impossible to trigger.
- The set of platform APIs the library depends on is visible in one interface.

### Negative

- The environment object is threaded through the internals. Accepted; it is a single readonly
  reference held by the composition root and passed down at construction.
- The fakes must be faithful. Mitigated by conformance tests on the harness itself.

## Verification

The lint rule fails the build on any direct global access outside `src/environment/`;
the harness has its own conformance test suite.
