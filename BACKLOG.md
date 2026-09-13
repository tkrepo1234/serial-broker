# Backlog

Work that is agreed but not yet started. Ordered by when it becomes relevant, not by size.

---

## After beta: a full developer documentation site

**Requested by Tim, 2026-09-12. Explicitly scheduled for after the beta phase — then started early
at Tim's request on 2026-09-13.**

### Status

Started 2026-09-13. The toolchain questions below are decided in
[ADR-0020](./docs/adr/0020-documentation-toolchain.md): Sphinx with the Read the Docs theme,
chapters in Markdown (MyST), the API reference generated from TSDoc, Python in `docs/.venv`.
`npm run docs` builds `docs/site/`.

| Done                                                                | Still to do                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| Site skeleton, full outline, generated API reference                | Completing TSDoc where the generated reference is thin |
| Introduction, Installing, Quickstart                                | A CI step that builds the site; hosting                |
| How shared ports behave (the core chapter)                          |                                                        |
| Examples in all four tiers, type-checked by `npm run typecheck`     |                                                        |
| Configuration, Errors, Diagnostics, Internals                       |                                                        |
| Application API and Diagnostics API referenced in separate sections |                                                        |

### Found while writing the chapters

Checking every statement against the source turned up behaviour worth deciding on. A worker script
that fails to load now falls back to `BroadcastChannel` too (ADR-0007, amended). Fixed at once:
`SerialBroker.configure({ logPayloads })` was never passed on and did nothing, and the remediation
for `RECONNECT_EXHAUSTED` advised a second `setup()`, which is a no-op. Open, and documented as
they are:

- **Tabs on different protocol versions cannot detect each other.** The version is part of every
  lock and bus name, so `PROTOCOL_VERSION_MISMATCH` is practically never raised; the symptom is a
  tab that cannot open the device. A version-independent announcement channel would make the
  mismatch visible.
- **Codes that are never raised:** `MALFORMED_MESSAGE`, `OWNERSHIP_TRANSFER_TIMEOUT`, `UNKNOWN`.
  Either raise them where they apply or remove them before 1.0, while that is still cheap.
- **`STORAGE_CORRUPT` during `restore()` in a fresh tab only reaches the log**, because no
  configuration exists yet to deliver `onError` to.

Build a product-grade documentation site for developers, modelled on
[open62541 1.3](https://open62541.org/doc/1.3/).

### Why 1.3 specifically

Version 1.3 is the requirement, not an approximation: that release still shipped the
**Sphinx** documentation with the theme Tim wants. Later open62541 versions moved away from
it. So:

- Sphinx as the generator.
- The 1.3 theme, not whatever Sphinx ships by default.
- Its structure and tone as the model for ours — 1.3 is well organised _in content_, not only
  in appearance, and that is the part worth copying.

### What it must contain

|                             |                                                                                                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Examples, in four tiers** | _Simple_ (the smallest thing that works) → _All features_ (every capability, one at a time) → _Full-featured_ (a realistic application using them together) → _Advanced_ (the hard cases: failover, protocol layers on top, several devices).      |
| **Configuration options**   | Every option documented in depth: what it does, its default, its range, what changing it costs, and when you would. Not a table of one-liners.                                                                                                     |
| **How shared ports behave** | The core chapter. How coordination actually works internally, what an application can rely on, and what to watch out for — ownership transfer, the gap during a handover, write ordering across tabs, what `OWNER_LOST_DURING_WRITE` really means. |
| **Every API function**      | Each one documented in full: purpose, parameters, return value, every error it can raise, when to call it, and a worked example.                                                                                                                   |

The bar is **product-grade documentation for developers**, not a generated reference with
prose sprinkled on top.

### Open questions to settle before starting

- **Toolchain.** Sphinx is Python; this project's toolchain is Node. Decide whether to add a
  Python step, and whether the API reference is generated from TSDoc (typedoc → Markdown →
  Sphinx) or written by hand and kept in sync by review.
- **Hosting.** Where the built site lives.
- **Language.** English, consistent with the repository.

### Relationship to what exists now

The current `README.md`, `docs/architecture.md` and the ADRs are the raw material and are
accurate. They are not a substitute: the README is a decision aid for someone evaluating the
library, and the ADRs record reasoning rather than teach use.

---

## Rework the at-a-glance illustration

**Requested by Tim, 2026-09-13.** One page showing what serial-broker achieves and how it fits into
an application's landscape: not marketing for its own sake, but the picture that lets a developer
facing the serial-broker problem recognise this as the solution, whichever feature they need.

A first draft is in `design/at-a-glance.svg`. It was taken out of the documentation until it has
been reworked; the rework has to match the documentation's colours and style.

---

## Open findings from the project review of 2026-09-13

The verified defects were fixed in `6d31c59` and the commits after it. What remains needs a decision or is larger work.

### Decisions

- **Saved configurations are keyed by the protocol version**, so every protocol change discards
  them although their format did not change. Give storage its own schema version.
- **`configure()` only takes effect before the first call that builds the client.** Decide whether
  a late `configure()` should warn. (`exists`, `names`, `release` and `releaseAll` no longer build
  one while nothing is set up.)
- **Error codes that are never raised:** `MALFORMED_MESSAGE`, `OWNERSHIP_TRANSFER_TIMEOUT`,
  `UNKNOWN`. Raise or remove before 1.0.
- **A listener that throws is reported in every tab** (`LISTENER_THREW` is broadcast).
- **Tabs on different protocol versions cannot detect each other** (see "Found while writing the
  chapters").

### Refactorings

- One set of protocol guards (`decode.ts` and `decode-diagnostics.ts` each define them, and they
  already differ); one conversion from a configuration to setup options (`toOptions`,
  `toStorable`, `describeSettings`); a shared base for the two transports; `configNameOf()`.
- Test helpers duplicated across files: recording logger, fake ports, message envelopes,
  transport request recorders, the device constant; `facade.test.ts` could use the harness fakes.
- Debugging surface: one `formatDevice()` and one error description; placeholders filled from
  the library's defaults; a generated Close button for the help popovers; "Decode text" starts
  checked although the dialog says blank means default.
- Dead code: unused getters (`PortSupervisor.status`, `isOpen`), `ConfigurationSession.#disposal`,
  `TransportRequest.workerUrl`, the `docs:api` script, the no-op `exclude` in
  `tsconfig.build.json`, duplicated `.prettierignore` entries.
