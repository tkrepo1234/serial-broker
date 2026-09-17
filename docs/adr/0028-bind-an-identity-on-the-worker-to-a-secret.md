# ADR-0028: Bind an identity on the worker to a secret sent in `hello`

- **Status:** Superseded by [ADR-0006](./0006-sharedworker-as-message-broker.md) (2026-09-15)
- **Date:** 2026-09-14

**Decision, as first recorded:** Every worker transport shows a random secret in `hello`, and the
worker refuses a later `hello` for that identity with another secret.
