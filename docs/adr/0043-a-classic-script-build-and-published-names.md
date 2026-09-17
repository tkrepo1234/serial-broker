# ADR-0043: Ship a classic script build on one global; name published files after the package

- **Status:** Accepted

## Context

This library is for industrial production interfaces, and a large part of that audience runs a
page on a station: served by whatever web server the site already has, maintained by people who
own no JavaScript toolchain, and often written against a browser policy that was settled years
ago. Without a bundler, an ES module build is loaded through a
`<script type="module">`, an import map, and a bare specifier. That is three mechanisms a page has
to get right before it can call `setup()`, and an inline import map additionally needs its own
hash in `script-src` under a strict content security policy.

A page that writes `<script src="…"></script>` and then calls a global needs none of that. It is
also what a great deal of existing plant software is written as, and what a technician adding a
device readout to an existing page will write.

Two things shape such a build.

**The worker script.** A `SharedWorker` is identified by its script URL
([ADR-0006](./0006-sharedworker-as-message-broker.md)). Every build of this library has to look
for the same `serial-broker.worker.js`, or its tabs coordinate with nobody. The library finds it
with `new URL('./serial-broker.worker.js', import.meta.url)`, and **a classic script has no
`import.meta`** — exactly the CommonJS build's problem, for which
`scripts/import-meta-stand-in.mjs` refuses to guess.

**The names.** A bundler names its output after the entry file it is built from: `index.js`,
`index.min.js`, `index.cjs`, `index.d.ts`, `diagnostics.min.js`. Someone copying `index.min.js` onto
a web server, next to their own `index.html`, cannot tell what it is — and `index` is not the name
of anything a reader of this project knows.

## Decision

**A classic script build of each entry point, one global each.**

| File                                       | Global                    | Loaded as                                |
| ------------------------------------------ | ------------------------- | ---------------------------------------- |
| `dist/serial-broker.global.js`             | `SerialBroker`            | `<script src="serial-broker.global.js">` |
| `dist/serial-broker.diagnostics.global.js` | `SerialBrokerDiagnostics` | the same, on a support page              |

Both are IIFEs, minified, with source maps, built by `config/tsup.config.ts` from `src/global.ts`
and `src/global-diagnostics.ts`. They are reached from the package as `serial-broker/global` and
`serial-broker/diagnostics/global`.

**`SerialBroker` is the facade, and carries the rest of the surface.** `SerialBroker.setup()`,
`.subscribe()`, `.send()`, `.requestAccess()`, `.release()`, `.configure()` read exactly as they
do in a module, and the package's other exports are properties of that same object:
`SerialBroker.SerialBrokerError`, `.SerialBrokerErrorCode`, `.SerialBrokerStatus`, `.REMEDIATION`,
`.isSerialBrokerError()`, `.hasCode()`, `.isSupported()`, `.PROTOCOL_VERSION`. A page needs exactly one name,
and can say what it took from this library.

`SerialBrokerDiagnostics` is the other way round — a namespace object carrying
`openDiagnostics()`, `CONNECTION_STATES` and `DEFAULT_COLLECT_WINDOW_MS`. The diagnostics entry
point has three exports and no facade to be, and `SerialBrokerDiagnostics(...)` would say less
than the call it stands for.

**The diagnostics entry point has a classic build too.** The audience is the same one: a support
page on a station, opened by a technician, served next to the application by the same web server
that cannot be given a toolchain. Without it `SerialBroker` would be the only surface such a
deployment can reach, so a support page would need exactly the toolchain the deployment does not
have.
It costs one more entry in the same bundler configuration and one more row in the parity check.

**`src/global.ts` takes its surface from `src/index.ts`**, which is the one place in the library
that imports through an entry point (`docs/guidelines/coding-style.md`). Taking the surface from
the package's own entry point is what makes the global and the ES module build the same surface by
construction rather than by a list kept in step by hand. Neither global entry point exports
anything: they are loaded for their effect on `globalThis`, and a classic script has no exports to
take.

**One worker file, one URL, for every build.** There is no second worker script and no second URL.
The classic build looks for the same `serial-broker.worker.js` as the readable, minified and
CommonJS builds; `scripts/check-dist.mjs` asserts that every one of the eight published entry-point
files names it, and `test/browser/entry-points.spec.ts` proves it in a browser by having a tab on
the classic build and a tab on the ES module build share one port and one `SharedWorker`.

**`configure({ workerUrl })` is required with the classic build**, before the first `setup()`.
Reading `import.meta.url` in this build throws a sentence that names the fix
(`scripts/import-meta-stand-in.mjs`), exactly as in the CommonJS build. Nothing is guessed: a URL
derived from `document.currentScript` or `document.baseURI` would resolve next to the _page_, so
two pages at different paths would name different URLs and each get a `SharedWorker` of its own —
a silent split, which is worse than an explicit requirement. Without `workerUrl` the library falls
back to a `BroadcastChannel` and logs `environment.transport-fallback` with a reason naming
`workerUrl`, or fails with `BROKER_UNAVAILABLE` under `transport: 'sharedworker'`.

**Every published file is named after the package**, not after the entry file it was built from.
The bundler is told these names through its entry keys; `tsc` names declarations after their
source files, so `scripts/entry-declarations.mjs` renames the two entry declarations after it
runs. The source files have their conventional names, which TypeDoc's entry points, the guidelines
and the documentation use; the facade is `src/facade.ts`, which leaves the published name free.

| Built from                           | Published as                                                    |
| ------------------------------------ | --------------------------------------------------------------- |
| `src/index.ts`                       | `dist/serial-broker.js`, `.cjs`, `.min.js`, `.d.ts`             |
| `src/diagnostics.ts`                 | `dist/serial-broker.diagnostics.js`, `.cjs`, `.min.js`, `.d.ts` |
| `src/global.ts`                      | `dist/serial-broker.global.js`                                  |
| `src/global-diagnostics.ts`          | `dist/serial-broker.diagnostics.global.js`                      |
| `src/worker/serial-broker.worker.ts` | `dist/serial-broker.worker.js`                                  |

The package's subpaths are `serial-broker`, `serial-broker/min`, `serial-broker/diagnostics`,
`serial-broker/diagnostics/min`, `serial-broker/worker`, `serial-broker/global` and
`serial-broker/diagnostics/global`. An application that imports by package name never sees a file
name; a path written to a file inside the package — a deployment's copy step, an import map, a
server's existence check — names a file that says what it is.

The worker script's minification belongs to the build outputs and is recorded in
[ADR-0003](./0003-typescript-and-toolchain.md).

## Alternatives considered

- **No classic build; tell people to use an import map.** It works.
  Rejected because the import map is one more thing to get right for an audience whose whole
  problem is that they own no toolchain, and because it is the part of such a page that most often
  needs a content security policy changed — an inline import map
  needs its hash in `script-src`, which a static server cannot generate and a formatter can
  invalidate.
- **A UMD build.** One file that works as CommonJS, AMD and a global. Rejected: the CommonJS build
  is what `require` loads, AMD has no audience here, and the detection preamble
  is exactly the kind of thing that picks the wrong branch inside someone's legacy loader. An IIFE
  does one thing.
- **`globalName` in the bundler, giving the module namespace as the global.** The natural IIFE
  output: `SerialBroker.SerialBroker.setup()`, because the facade is one of the module's exports.
  Rejected — a page would either write that, or start with a line of unpacking. The global is the
  facade instead, and the other exports hang off it.
- **Several globals: `SerialBroker`, `SerialBrokerError`, `SerialBrokerStatus`, …** Closer to what
  the module exports look like. Rejected: a build that takes nine names off a page cannot be
  reasoned about by whoever maintains that page, and a collision is found at run time, in one
  browser, on one station.
- **A `SerialBroker.default` or `SerialBroker.SerialBroker` alias for symmetry with the module.**
  Rejected as a second spelling of one thing; `check-dist` pins the surface instead.
- **Let the classic build guess the worker URL** from `document.currentScript.src`. Plausible, and
  it would work for a single page. Rejected for the reason under Decision: it resolves per page,
  so two pages of one application would silently get two workers — the failure this library exists
  to prevent, arriving without a message.
- **A second worker file for the classic build**, resolved relative to something it can see.
  Rejected outright: it is the same decision as a `Blob` URL, and ADR-0006 rules it out.
- **Leave the diagnostics entry point without a classic build.** See Decision.
- **`index.*` as the published names.** Conventional for a bundle, and it changes nothing for
  an application that imports by package name. Rejected because the audience that copies these
  files by hand is the audience this library is for, and for them `index.min.js` in a folder of
  their own files is an unlabelled box.
- **Rename the source entry files instead of the emitted declarations**, so `tsc` produces the
  published names directly. It would make `scripts/entry-declarations.mjs` unnecessary. Rejected because
  `src/index.ts` is the name the guidelines, TypeDoc's entry points, the documentation site and its
  generated reference directories all use: a checked twenty-line script costs less than a change to
  all of them.

## Consequences

### Positive

- A page can use the library with one `<script src>` and one name, and no import map — and so
  without the one inline script a strict `script-src` has to be given a hash for.
- Every published file says what it is when it is sitting in a folder on a web server.
- The classic and module builds cannot drift: `check-dist` runs the classic build in a context
  with no browser in it and compares the global it leaves behind with the ES module's exports.

### Negative

- Two more published files per entry point (the build and its map), and two more names in every
  place the builds are listed: the package's `exports`, the release archive, the deployment
  documentation.
- The classic build is `sideEffects`-flagged in `package.json` so a bundler cannot drop it. It is
  not meant for a bundler, and a bundled application should use `serial-broker`.
- `scripts/entry-declarations.mjs` is a build step that renames two generated files. It fails the
  build if either is missing, or if its target name is already taken.

### Risks and mitigations

- An export added to `src/index.ts` and forgotten in `src/global.ts`. `src/global.ts`
  imports through `src/index.ts`, so the surface is one list, and `check-dist` compares the built
  files after every build regardless.
- Someone adds a build that resolves its own worker URL. `check-dist` requires every published
  entry-point file to name `serial-broker.worker.js`, and the browser suite shares a port between
  builds.

## Verification

`scripts/check-dist.mjs` after every build: every `exports` target exists; the minified and classic
builds expose what the readable build exports; every published entry-point file names
`serial-broker.worker.js`; each classic build loads outside a browser without throwing and leaves
exactly one global, and `SerialBroker.isSupported()` is `false` there.

`test/browser/entry-points.spec.ts` in a real browser: a tab on `dist/serial-broker.global.js` and
a tab on `dist/serial-broker.js` set up the same configuration, see each other's traffic, hold one
port between them, and Chromium lists exactly one `SharedWorker`; the global carries the
documented surface and is the only global the build defines; and a page that does not call
`configure({ workerUrl })` is told so, by name, in `environment.transport-fallback`.

`examples/minimal-js` and `examples/terminal-openui5` load these files by name, and their smoke
tests run in CI.
