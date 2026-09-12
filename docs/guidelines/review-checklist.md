# Review Checklist

A reviewer works through this list explicitly. "Looks good to me" without it is not a review.

## Correctness under concurrency (the part that actually breaks)

- [ ] Does every `await` between a check and its dependent action re-validate the state it
      checked? (Classic TOCTOU: "I am the owner" → `await` → "write" — the role may have moved.)
- [ ] Can this code run twice concurrently in the same context? What happens if it does?
- [ ] Can this code run in two tabs at the same instant? Is the interlock a real mutual
      exclusion primitive (Web Locks) or an optimistic guess?
- [ ] If this context dies right here, at this line, what is left behind — a held lock, an
      open port, a pending write nobody will settle, a listener nobody will remove?
- [ ] Is every promise awaited, returned, or explicitly and justifiably fire-and-forget?

## Defensiveness

- [ ] Is every value from another context, from storage, or from the application validated
      before a field is read?
- [ ] Is every external call bounded by a deadline?
- [ ] Does every acquired resource have a disposal path that runs on both the success and
      the failure branch?
- [ ] Are numeric inputs range-checked, including `NaN`, `Infinity` and non-integers?
- [ ] Does anything hand out a reference to an internal mutable object or buffer?

## Errors

- [ ] Does every thrown error carry a code, context and specific remediation?
- [ ] Is every wrapped error chained via `cause`?
- [ ] Is anything reported twice, or not at all?
- [ ] Could a payload byte end up in a log record at `info` or above? (It must not.)

## API and encapsulation

- [ ] Does this widen the public surface? Is that intended and documented?
- [ ] Does anything observable reveal owner identity, worker internals or lock state?
- [ ] Is the new option optional, defaulted and documented?

## Tests

- [ ] Is there a test that fails without this change?
- [ ] Does any test depend on real time, real randomness or incidental task ordering?
- [ ] Does any test assert on a private field?
- [ ] Is the relevant row of the scenario matrix in [Testing](./testing.md) still covered?

## Documentation

- [ ] TSDoc on every touched export, with `@throws` current?
- [ ] Changelog entry for user-visible change?
- [ ] ADR for the architectural choice, referenced from the code?
