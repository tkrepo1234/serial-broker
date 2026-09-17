# ADR-0003: TypeScript, Vitest, tsup, ESLint and Prettier

- **Status:** Accepted

## Context

The library must ship as a consumable package for browser applications, with types, with both
ESM and CommonJS entry points, and with a separately loadable worker script. The test suite
must simulate several browser contexts deterministically, which rules out any runner whose
model is "one global environment per file" unless that environment is fully injectable.

## Decision

- **TypeScript** in maximally strict mode as the implementation language. See
  [typescript.md](../guidelines/typescript.md).
- **tsup** (esbuild) for bundling. The library (`src/index.ts`) and the diagnostics observer
  (`src/diagnostics.ts`, [ADR-0014](./0014-diagnostics-observer.md)) are built as ES modules and
  CommonJS, once more minified, and once more as classic scripts
  ([ADR-0026](./0026-a-classic-script-build-and-published-names.md)); the worker script
  (`src/worker/serial-broker.worker.ts`) is built as a minified ES module only. **Every published
  file is minified except the readable ES module and CommonJS builds and the debugging surface's
  bundle (ADR-0015)** — the worker included: it
  is served to every tab of every installation and nothing reads it, and its source map is
  published beside it. Every published file is named after the package rather than after its entry
  file (ADR-0026). Declarations are emitted by `tsc`, so the published types are the ones the test
  suite type-checks against.
- **Vitest** as the test runner, in the `node` environment. The library never touches the DOM;
  every browser API it uses is injected (see
  [ADR-0012](./0012-dependency-injection-of-the-environment.md)), so a DOM emulator would add
  nothing but noise and non-determinism.
- **ESLint** (flat config) with `typescript-eslint` for correctness rules, and **Prettier**
  for formatting, connected by `eslint-config-prettier` so the two never disagree.
- **typedoc** to generate the API reference from TSDoc, so the documentation cannot drift
  from the signatures ([ADR-0016](./0016-documentation-toolchain.md)).

## Alternatives considered

- **Rollup + plugins** instead of tsup: more control, considerably more configuration for the
  same output. Rejected; revisit if the worker bundling needs something esbuild cannot do.
- **Jest**: the ESM story and the worker/`postMessage` simulation are both more awkward, and
  its fake timers integrate less cleanly with the explicit message pump the multi-tab tests
  need.
- **Playwright / real Chromium for all tests**: gives genuine `SharedWorker` and Web Locks
  behaviour, but is slow, cannot kill a tab at a chosen instruction boundary, and cannot
  simulate a device being unplugged mid-write. Rejected as the primary layer; a small,
  scenario-shaped browser suite runs in CI on top of it
  ([ADR-0021](./0021-browser-tests-with-playwright.md)).
- **`happy-dom`/`jsdom` environment**: neither implements `SharedWorker`, Web Locks or Web
  Serial, so the fakes would be needed anyway — the emulator would only hide which globals
  the code actually depends on.

## Consequences

### Positive

- The in-process suite runs in seconds, so the multi-tab scenario matrix can be exhaustive.
- Injection is enforced by the absence of browser globals in the test environment: code that
  reaches for `navigator` directly fails immediately rather than silently in production.

### Negative

- The fakes must be faithful to the specifications, which is real work and a real risk. This
  is why the harness has its own tests ([testing.md](../guidelines/testing.md)), why the browser
  suite checks them against a real browser, and why a manual test plan against real hardware
  remains mandatory before a release.

## Verification

`npm run verify` runs format check, lint, type-check, tests with coverage gates, and build;
`scripts/check-dist.mjs` checks the built entry points after every build.
