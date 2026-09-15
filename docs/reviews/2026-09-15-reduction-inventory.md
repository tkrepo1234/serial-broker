# Complexity and code reduction: inventory before the work

**Date:** 2026-09-15, at `main` = `320f49a` (protocol version 10). Requested by Tim on 2026-09-14
(`BACKLOG.md`, "Complexity and code reduction"); its definition of done asks for a written inventory
before the work starts and the same inventory afterwards. This is the "before". It was compiled from
five read-only reviews of the repository - the synchronisation protocol, the ADRs, the tests, the
documentation and the project directory - and condenses what they found.

## Size

| Measure                     | Before                                                           |
| --------------------------- | ---------------------------------------------------------------- |
| `src/`                      | 54 files, 14 533 lines                                           |
| Largest source files        | configuration-session 1 417, port-supervisor 1 103, client 1 037 |
| Tests (spec and test files) | 107 files, 23 865 lines (117 files, 27 128 lines with support)   |
| In-process tests            | 1 390 (1 368 run, 22 opt-in extreme), about 12 s                 |
| Markdown                    | 14 148 lines                                                     |
| ADRs                        | 39 (plus template), about 4 040 lines                            |
| Protocol message types      | 19                                                               |

## The synchronisation protocol

What each mechanism protects against, and what the review proposed. Estimated savings are for `src/`.

| Mechanism                                         | Protects against (ADR)                                                  | Proposal                                                              | Est. lines | Risk     |
| ------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- | -------- |
| 19 message types                                  | Misreading across builds (0008)                                         | Fold heartbeat/attach/detach/goodbye into `hello`: 19 → 15            | 110        | medium   |
| Handshake and version announcement                | A stale worker script or mixed deployment unreported (0023/0024)        | One report, one constants module                                      | 60         | low      |
| Identity secret                                   | A script receiving what is addressed to one tab (0028)                  | Remove; integrity rests on term locks                                 | 110        | medium   |
| Heartbeats                                        | Dead tabs kept; a dead worker unnoticed (0021)                          | One liveness clock; later, liveness through Web Locks                 | 40 / 180   | low/high |
| Election, tab slots, persistence holds, term lock | Two owners; lost places; forgotten configurations (0005/0025/0027/0030) | One held-lock helper; term lock taken inside the election             | 200        | low      |
| Owner terms                                       | Forged or late claims; double writes after a handover (0026/0030)       | One flood bound; one authorisation table                              | 50         | medium   |
| Pending, accepted, started writes; late deadlines | Repeating a write after the holder died (0013/0031/0038)                | Bound and "all answered" in the supervisor; fewer redispatch triggers | 90         | medium   |
| Rate and size limits                              | A hostile same-origin script (0031)                                     | One once-log; drop three redundant limits; keep every size bound      | 80         | low      |
| Worker record forwarding                          | Worker warnings seen by nobody (0029)                                   | Once per key, no interval budget                                      | 80         | low      |
| Diagnostics validation                            | Operators blind to coordination state (0018)                            | Budget plus top-level check                                           | 110        | low-med  |
| Fallback transport                                | A worker script that fails to load (0007)                               | No broker messages over BroadcastChannel; state restore for replay    | 130        | low/med  |

Found on the way, and taken into the reduction rather than left:

- **A forged `owner-claimed` could take over the worker's routing of writes** on the SharedWorker
  transport: the broker believed any claim and routed messages for the owner to the claimant.
- **A suspected re-dispatch loop of `NOT_CONNECTED`** during a clean release of the port, untested.
- **`error` messages were accepted from any sender**, unlike data.
- Dead code: broker messages the BroadcastChannel transport posts and every receiver drops,
  test-only getters, `chunkBytes`, the discarding of a storage format that was never released.
- Four copies of the same Web Lock retry loop and nine separate "log once" flags.

## The ADRs

39 records in eleven clusters; 16 of them amend or are amended by others, several carry in-place
amendments although ADR-0001 calls records immutable. Proposed: 23 current decisions and 16
superseded pointers, about 1 000 lines fewer. Drift found, among others: ADR-0031 names the wall
clock for rates the code measures monotonically; ADR-0032 cites a grace period ADR-0030 removed;
ADR-0036 still says protocol version 9 and `persist`; ADR-0013 still says a resolved write reached
the device; ADR-0020 says CI does not build the site, which it does.

## The tests

About 2 400 - 2 600 test lines (10 %) and 5.5 of the 12 in-process seconds can go without losing a
row of the scenario matrix: duplicated decoder tests, the worker routing tested three times, storage
and reconnect behaviour pinned in unit and integration alike, the failover write test in four
variants, log wording asserted instead of behaviour, a 100 000-write test covered elsewhere, and the
same four scenarios copied into nine example smoke tests. Two gaps were found: two configurations
used from the same several tabs (matrix row 11), and two real tabs on different protocol versions
(row 13).

## The documentation

The same facts live in up to ten places - option defaults, what a resolved `send()` means, the
at-most-once guarantee, failover, install steps, browser requirements, status names. Drift: several
chapters and four example READMEs still say `setup()` does nothing for a failed configuration;
receiving is described as chunk-by-chunk in most places after ADR-0039; the README promises
at-most-once without the crash exception `shared-ports.md` states; `persist` survives in TSDoc and
ADRs. Proposed: a "Guarantees" chapter as the single home of every promise, a README of about 90
lines, generated or checked option tables.

## The project directory

Every script has a caller and CI names no missing path. To clean up: `docs/architecture.md`
duplicates `docs/site/internals.md`; the dated usability review sits among living documents; stale
entries in `.gitignore` and `.prettierignore`; `typedoc.json` only serves as the base of
`typedoc.site.json`; the README does not describe the layout. `design/` waits for Tim's assessment of
the illustration and stays.

## After the work

**Date:** 2026-09-15, later the same day, at the merge of the ADR roll-up (protocol version 12).

| Measure                     | Before                  | After                                                         |
| --------------------------- | ----------------------- | ------------------------------------------------------------- |
| `src/`                      | 54 files, 14 533 lines  | 51 files, 13 267 lines                                        |
| Protocol message types      | 19                      | 15                                                            |
| Tests (spec and test files) | 107 files, 23 865 lines | 108 files, 21 900 lines, the examples' smoke tests included   |
| In-process tests            | 1 390, 6.6 s warm       | 1 407 (1 385 run, 22 opt-in extreme), about 3 s warm          |
| Markdown                    | 14 148 lines            | 12 875 lines                                                  |
| ADRs                        | 39, about 4 040 lines   | 41: 24 current decisions and 17 superseded stubs, 2 832 lines |

What the protocol review proposed and what became of it:

- **Done:** routing to every participant instead of to an owner the worker believed, which closes the
  forged-claim hole; the identity secret removed; liveness through Web Locks instead of heartbeats and
  a sweep, which also ended the one-minute stall after the crash of the tab that started the worker;
  19 message types down to 15; one held-lock helper for the election, tab slots, persistence holds and
  the term lock; one once-log instead of nine flags; worker records once per key; one authorisation
  table for who may say what, with `error` accepted only from the tab holding the port; the write bound
  and "all answered" in the supervisor; a diagnostics report checked at the top level only; the
  fallback restating instead of replaying; dead code, test-only API and a never-released storage format
  removed.
- **Not reproduced:** the suspected `NOT_CONNECTED` re-dispatch loop during a release; a test pins that
  it does not happen.
- **Kept on purpose:** the frozen handshake and announcement stay separate contracts; every payload,
  queue and report size bound stays.
- **Traded, and documented as known limits:** a worker that hangs after answering is no longer noticed,
  and messages on their way when a tab changes bus are not repeated.

The line count of `src/` fell by less than the review estimated, because liveness through locks needs
code of its own. What went is mechanism - timers, a sweep, counters, a replay log, four message types -
and the special cases that came with it.

For the ADRs, tests, documentation and directory, see the CHANGELOG entries of the same date: the ADR
index shows only current decisions with a superseded trail; duplicated and slow tests were removed and
two coverage gaps closed; the documentation keeps each promise in one chapter (Guarantees), and a test
checks documented defaults, ranges and log events against the source; the README describes the
repository layout; `docs/architecture.md` is merged into Internals.
