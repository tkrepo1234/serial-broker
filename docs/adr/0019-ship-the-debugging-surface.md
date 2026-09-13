# ADR-0019: Ship the debugging surface in the package, as static content

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

The repository had a demo page in `examples/demo/`: a small form, a status line and a traffic log,
built only for manual testing and never published. The requirement (2026-09-13) is different in
kind: a debugging surface that ships **with the library**, exposes **every** setting and **every**
piece of status, and is **content only** — whether and how it is reachable is the operator's
decision.

Three facts constrain it:

- **It has to run on the application's origin.** Tabs of different origins share nothing, so a
  page anywhere else cannot see the application's tabs.
- **It has to find the application's bus.** A `SharedWorker` is identified by its script URL; a
  page loading the worker from a different URL talks to a broker of its own.
- **It can act, not only look.** It sends bytes to devices and can revoke device permissions.

## Decision

The demo is replaced by a debugging surface in `debug/`, built into **`dist/debug/`** by the normal
build and therefore published with the package. It is **static content**: nothing in the library
serves it, links to it or loads it, and the package's `exports` map `./debug/*` only so a bundler
can resolve its files.

- It exposes every option of `setup()` and `configure()`, every field of `getStatus()`, all four
  events and the library's log records for the tab it runs in; and, through the diagnostics
  observer (ADR-0018), every tab of the origin, the Web Locks, and a live watch of any
  configuration.
- It **sets nothing up on its own**, and does not call `restore()` on load as the demo did.
  Opening it to look must not make it a participant, or it would end up owning a port when the
  application's tabs close.
- It loads the worker next to itself by default, and takes the worker URL and transport from its
  settings panel, from storage, or from the query string, so an operator can point it at the
  application's bus and share a link that does.
- It is an application page, not library code: it bundles the library from source and uses the
  client directly, so it can mark its own tab in the origin view. It is type-checked and linted
  with the repository, and its logic is unit-tested.

## Alternatives considered

- **Keep it in the repository only.** Then the people it is for — operators of a deployment — do
  not have it. Rejected; that is the requirement.
- **A separate package** (`serial-broker-debug`). Versioning it against the library adds a failure
  mode — a debug page on protocol version 2 against an application on version 3 sees nobody —
  for no benefit, since the files are small and inert. Rejected.
- **Serve it from the library**, for instance a route registered by a helper. The library runs in
  the browser and serves nothing; and choosing a route for an operator is exactly the decision the
  requirement leaves to them. Rejected.
- **Build it into the main bundle behind a call** (`SerialBroker.openDebugPage()`). Puts an
  operator tool one call away from application code and grows every application's bundle.
  Rejected.

## Consequences

### Positive

- Every installation carries a page that answers "what is serial-broker doing right now?" in any
  tab of the origin, without changing the application.
- The manual test plan runs against the same page operators use.

### Negative

- The package is larger by the page and its bundle, which inlines a copy of the library. Nothing
  imports it, so no application bundle grows.
- **An operator who serves `dist/` wholesale exposes a page that can send to devices and revoke
  permissions.** The README says so plainly; nothing technical prevents it, because preventing it
  would be the library deciding for the operator.

### Risks and mitigations

- **Pointed at the wrong worker URL, the page silently sees nobody.** The origin panel says that
  nobody answered and names the likely cause; the platform panel shows which transport each side
  ended up on.

## Verification

`test/unit/debug-surface.test.ts` pins the form's pass-through to the library's own validation,
exact reproduction of a running configuration from its reported settings, settings precedence,
and formatting. The page itself is exercised by the manual test plan.
