# ADR-0019: Ship the debugging surface in the package, as static content

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

The repository had a demo page in `examples/demo/`: a small form, a status line and a traffic log,
built only for manual testing and never published. The requirement (2026-09-13) is different in
kind: a debugging surface that ships **with the library**, exposes **every** setting and **every**
piece of status, and is **content only** — whether and how it is reachable is the operator's
decision.

Four facts constrain it:

- **It has to run on the application's origin.** Tabs of different origins share nothing, so a
  page anywhere else cannot see the application's tabs.
- **It has to find the application's bus.** A `SharedWorker` is identified by its script URL; a
  page loading the worker from a different URL talks to a broker of its own.
- **It can act, not only look.** It sends bytes to devices and can revoke device permissions.
- **It ships as static files that operators serve**, often with no policy of their own. Part of
  what the page may do is decided by its own markup: inline styles force every policy written for
  it to allow them, and `frame-ancestors` cannot be set from the page at all.

## Decision

The demo is replaced by a debugging surface in `debug/`, built into **`dist/debug/`** by the normal
build and therefore published with the package. It is **static content**: nothing in the library
serves it, links to it or loads it, and the package's `exports` map `./debug/*` only so a bundler
can resolve its files.

- It exposes every option of `setup()` and `configure()`, every field of `getStatus()`, all four
  events and the library's log records for the tab it runs in; and, through the diagnostics
  observer ([ADR-0018](./0018-diagnostics-observer.md)), every tab of the origin, the Web Locks,
  and a live watch of any configuration.
- It **sets nothing up on its own**, and does not call `restore()` on load. Opening it to look must
  not make it a participant, or it would end up owning a port when the application's tabs close.
- Its first action for a developer is _Choose a device…_, which sets a configuration up in auto
  mode and calls `requestAccess()` in the same click, so no vendor or product ID has to be known
  ([ADR-0036](./0036-take-the-device-identity-from-the-chosen-port.md)).
- It loads the worker next to itself by default, and takes the worker URL and transport from its
  settings panel, from storage, or from the query string, so an operator can point it at the
  application's bus and share a link that does.
- **It carries a strict `Content-Security-Policy` of its own**, as a `<meta>` element, so it holds
  wherever the page is served:

  ```text
  default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self';
  img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
  ```

  Its styles live in `dist/debug/debug.css`, and no element carries a `style` attribute.
  `frame-ancestors` stays a header the operator sends; `debug/README.md` gives the complete policy,
  and the page refuses to start in a frame of another origin.

- It is an application page, not library code: it bundles the library from source and uses the
  client directly, so it can mark its own tab in the origin view. It is type-checked and linted
  with the repository, and its logic is unit-tested. A page that cannot start - no Web Serial -
  hides every control that would set a configuration up, named in one place, `SETUP_ACTION_IDS`.

## Alternatives considered

- **Keep it in the repository only.** Then the people it is for — operators of a deployment — do
  not have it. Rejected; that is the requirement.
- **A separate package** (`serial-broker-debug`). Versioning it against the library adds a failure
  mode — a debug page on another protocol version than the application sees nobody — for no
  benefit, since the files are small and inert. Rejected.
- **Serve it from the library**, for instance a route registered by a helper. The library runs in
  the browser and serves nothing; and choosing a route for an operator is exactly the decision the
  requirement leaves to them. Rejected.
- **Build it into the main bundle behind a call** (`SerialBroker.openDebugPage()`). Puts an
  operator tool one call away from application code and grows every application's bundle.
- **Derive a configuration from the chosen port in the page itself.** What the page did from
  2026-09-14 until auto mode moved the derivation into the library; it helped this page only, and
  the configuration it produced was not shared with other tabs.
- **Keep the styles inline and allow `'unsafe-inline'`, or hash the block.** The allowance covers
  any inline style an injection places; a hash breaks on every edit, and `style` attributes would
  still need `'unsafe-hashes'`. A stylesheet file costs one request and needs neither.
- **Leave the policy to the operator entirely.** An operator who serves `dist/` wholesale sends no
  policy at all, and this is the page that can send bytes to devices.

## Consequences

### Positive

- Every installation carries a page that answers "what is serial-broker doing right now?" in any
  tab of the origin, without changing the application.
- The manual test plan runs against the same page operators use.
- The page runs with no inline script and no inline style, on `default-src 'none'`. An injected
  `<script>`, a `<base>` tag or a form posting elsewhere does not execute, redirect or send.

### Negative

- The package is larger by the page and its bundle, which inlines a copy of the library. Nothing
  imports it, so no application bundle grows.
- **An operator who serves `dist/` wholesale exposes a page that can send to devices and revoke
  permissions.** The documentation says so plainly; nothing technical prevents it, because
  preventing it would be the library deciding for the operator.
- `debug.css` has to be served with `index.html`, and a copy served through something that rewrites
  HTML or injects a script breaks under its own policy.

### Risks and mitigations

- **Pointed at the wrong worker URL, the page silently sees nobody.** The origin panel says that
  nobody answered and names the likely cause; the platform panel shows which transport each side
  ended up on.

## Verification

`test/unit/debug-surface.test.ts` pins the form's pass-through to the library's own validation,
exact reproduction of a running configuration from its reported settings, settings precedence,
auto mode by default, formatting, and the header controls against `SETUP_ACTION_IDS`. The policy
was checked in Chromium against a build served from `dist/`: no `securitypolicyviolation` while the
page is used, and an inline `<script>` added to the loaded page does not execute. The page itself is
exercised by the manual test plan.

## History

- 2026-09-13: Accepted.
- 2026-09-14: _Choose a device…_ derived a configuration from the chosen port, and the page gained
  its own `Content-Security-Policy` (ADR-0034); the derivation moved into the library as auto mode
  (ADR-0036).
- 2026-09-15: The policy folded in from ADR-0034, whose derivation part is retired.
