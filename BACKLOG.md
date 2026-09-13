# Backlog

Work that is agreed but not yet started. Ordered by when it becomes relevant, not by size.

---

## Tell tabs what they missed while the worker was gone

**Found 2026-09-13, while making tabs reconnect to a new worker (ADR-0021, amended).**

A tab whose heartbeats go unanswered now connects its transport to a new worker by itself, with
`hello` and a heartbeat. Nothing above the transport learns that it did, so nothing lost in the gap
is asked for again:

- A tab that reaches the new worker before the owner does sends its `status-request` into a broker
  that knows no owner, where it is dropped. Once the owner arrives, nothing restates the status, so
  the tab shows what it knew before - or nothing, if it set up during the gap - until the status
  next changes.
- A write dispatched into the dead worker counts as handed to the owner, and `PendingWrites` only
  dispatches it again on `owner-claimed`. It ends in `WRITE_TIMEOUT`, although it may never have
  reached the owner.
- Status changes and errors broadcast during the gap are not repeated.

Sketch: a `TransportRequest.onReconnected` callback, on which the client sends `status-request` for
every configuration and hands on writes that have not started. Handing a write on again needs the
owner to recognise a request id it has already seen, or a write the dying worker did deliver could
run twice. It touches `src/client/serial-broker-client.ts`, `configuration-session.ts` and
`pending-writes.ts`, which is why it was left out of the transport change. The scenario to extend is
`test/integration/multi-tab/worker-restart.test.ts` ("are joined by a tab opened after the crash":
let that tab write).

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

Decided by Tim on 2026-09-13 and done:

- Stored configurations have a storage version of their own and are moved from the old keys
  ([ADR-0022](./docs/adr/0022-version-stored-configurations-separately.md)).
- `MALFORMED_MESSAGE` and `OWNERSHIP_TRANSFER_TIMEOUT` are removed; `UNKNOWN` is what a code
  reported by a later version becomes.
- `LISTENER_THREW` is reported in the listener's own tab only.
- Tabs announce their protocol version on an unversioned channel
  ([ADR-0023](./docs/adr/0023-announce-the-protocol-version.md)).
- A late `configure()` logs `facade.late-configure`.

### Refactorings

Done on 2026-09-13: shared protocol guards, one conversion to setup options, a shared message
sender for both transports, `configNameOf()`, shared test helpers, the debugging surface's
duplicates, and the dead code.
