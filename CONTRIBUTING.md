# Contributing

Thank you for considering it. This library coordinates a physical resource across contexts
that can disappear at any moment, so the bar for changes is higher than the size of the
codebase suggests.

## Before you write code

Read [the engineering guidelines](./docs/guidelines/). They are binding, not advisory, and
they are short. The three that decide most reviews:

- [Defensive Programming](./docs/guidelines/defensive-programming.md) — what may be trusted,
  and where.
- [Testing](./docs/guidelines/testing.md) — including the scenario matrix every release must
  keep green.
- [API Design](./docs/guidelines/api-design.md) — what the public surface may and may not say.

If you are changing how contexts coordinate, read [ADR-0005](./docs/adr/0005-owner-election-via-web-locks.md)
and [ADR-0013](./docs/adr/0013-write-ordering-and-delivery-semantics.md) first. Both record
decisions that look replaceable and are not.

## Setting up

```sh
npm install
npm test          # ~1s
npm run verify    # what CI runs
```

Node 20.11 or newer. The library itself never runs in Node — that is only the toolchain.

## Making a change

1. Branch: `<type>/<short-description>`.
2. Write the failing test first. For anything touching `src/client/`, `src/worker/` or
   `src/owner/`, that test belongs in `test/integration/multi-tab/` and must run against both
   transports.
3. Make it pass.
4. `npm run verify` must be green, including the coverage gates.
5. Commit with [Conventional Commits](./docs/guidelines/git-workflow.md). The body explains
   _why_; the diff already shows _what_.
6. Update `CHANGELOG.md` if the change is user-visible, and TSDoc on every touched export.
7. Write an ADR if you made or reversed an architectural decision, and reference it from the
   code.

## Before a release

Work through [the manual test plan](./docs/manual-test-plan.md) against real hardware and
record the result. The simulated browser is faithful, but a fake that is wrong in the same way
as the code passes every test.

## What gets a change rejected

- A test that depends on real time, real randomness, or incidental task ordering.
- A test that reaches into private state to assert an implementation rather than a contract.
- A retry of a write that may already have reached the device. Ever.
- A new field on the public surface that reveals which context owns the port.
- `catch {}` with no comment saying why the error is genuinely uninteresting.
- An `await` between a state check and the action that depends on it, with no re-check.

## Reporting a bug

Include the browser version, the operating system, the device, how many tabs were open, and
the `code` and `context` of any `SerialBrokerError` you saw. A multi-tab timing bug is almost
impossible to act on without those.
