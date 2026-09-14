# ADR-0014: Inject the browser environment for testability

- **Status:** Accepted, amended by [ADR-0032](./0032-measure-durations-on-a-monotonic-clock.md)
- **Date:** 2026-09-12

> **Amendment (ADR-0032).** `Clock` has a second reading, `monotonicNow()` (`performance.now()`),
> and every duration is measured with it; `now()` remains the wall clock, for timestamps.

> **Amendment (2026-09-14): the narrowed interfaces name no ambient type.** `SerialLike` described
> the part of `Serial` this library uses, but in the platform's own types: `getPorts(): Promise<SerialPort[]>`.
> `SerialPort`, `SerialOptions`, `SerialPortRequestOptions` and the rest are _ambient_ types,
> declared globally by `@types/w3c-web-serial` — a package this library cannot make an application
> install, and whose version it must not dictate. Every published declaration that named one of them
> therefore failed to type-check in an application without that package, and the entry points worked
> around it by not re-exporting anything that reached those declarations.
>
> `src/environment/environment.ts` now declares `SerialPortLike`, `SerialOptionsLike`,
> `SerialPortInfoLike`, `SerialPortRequestOptionsLike` and `SerialPortFilterLike` — the same
> narrowing as `SerialLike`, one level deeper — and nothing in `src/` names an ambient Web Serial
> type any more. `navigator.serial` satisfies them structurally, so the composition root still
> assigns it without a cast; the one exception is a device event's `target`, which the platform
> types as the `EventTarget` every event has, and which `SerialBrokerClient` reads as a port in the
> single place that does so.
>
> `scripts/check-dist.mjs` type-checks **every** emitted `.d.ts`, not only the ones an entry point
> reaches, with `skipLibCheck: false`, `types: []` and the `ES2022` and `DOM` libraries — so a
> declaration for a deep import is held to the same rule, and a Web Serial type creeping back into
> any of them fails the build. The repository keeps `@types/w3c-web-serial` as a dev dependency:
> `navigator.serial` is reachable only through its `Navigator` augmentation.
>
> Rejected: shipping the ambient types with the package (they would collide with the copy an
> application already has, and a global declaration is not a package's to make); a `declare global`
> of our own (the same collision, plus a global for a library that needs none); telling applications
> to install `@types/w3c-web-serial` (a transport wrapper must not dictate a types version, and
> nothing in the public API exposes a `SerialPort` anyway).

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
      readonly clock: Clock;              // now(), monotonicNow(), setTimeout, clearTimeout
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
