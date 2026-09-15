# ADR-0028: Bind an identity on the worker to a secret sent in `hello`

- **Status:** Superseded by [ADR-0006](./0006-sharedworker-as-message-broker.md) (2026-09-15)
- **Date:** 2026-09-14

**Decision, as first recorded:** Every worker transport shows a random secret in `hello`, and the
worker refuses a later `hello` for that identity with another secret.

**Trail:** Superseded by ADR-0040 on 2026-09-15 (the secret is removed; routing no longer depends on
an identity), which is folded into ADR-0006.
