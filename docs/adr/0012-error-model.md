# ADR-0012: One error type, stable codes, mandatory remediation

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

Failures in this library originate in four places with four unrelated error vocabularies: the
application (bad arguments), the Web Serial API (`DOMException` with names like
`NetworkError`, `InvalidStateError`, `SecurityError`, `BreakError`), the coordination layer
(protocol mismatch, transfer timeout), and the storage layer (quota, corruption). Propagating
those raw would force every consumer to learn all four, and `DOMException` messages differ
between Chromium versions.

Errors also have to cross context boundaries: an error that happens in the owning tab must be
reported in every other tab, which means it has to survive structured cloning - and `Error`
objects lose subclass identity and custom fields when cloned.

## Decision

One error class, `SerialBrokerError extends Error`, carrying:

| Field | Purpose |
| --- | --- |
| `code` | Stable, documented, machine-readable. The only thing consumers should branch on. |
| `configName` | Which configuration, when applicable. |
| `context` | Structured, structurally-cloneable detail (attempt number, timeout value, peer version...). |
| `remediation` | A specific, actionable sentence for the developer. Mandatory. |
| `isRetryable` | Whether the library is handling it by retrying. |
| `timestamp` | From the injected clock. |
| `cause` | The original error, always chained, never discarded. |

Plus `toJSON()` producing a `SerializedSerialBrokerError`, and a matching
`deserializeError()`, so an error raised in the owner is reconstructed faithfully in every
other context - including its `code`, `context` and `remediation`, with the original
`DOMException` reduced to a plain `{ name, message }` in `cause`.

Every `DOMException` from Web Serial is mapped to a library code by an explicit table, not by
string matching on the message.

## Alternatives considered

- **A class per error kind** (`PortOpenError`, `WriteFailedError`, ...). Idiomatic and allows
  `instanceof` dispatch, but subclass identity does not survive structured cloning, so the
  receiving tab would see a different type than the originating one - the one property this
  library needs most. Rejected; the `code` field gives the same discrimination and is
  serialisation-proof.
- **Return values instead of exceptions** (a `Result` type). Excellent for a total API, but it
  fights the ecosystem: `await` and `try/catch` are what a JavaScript developer expects, and a
  library that returns error objects from `send()` will have them ignored.
- **Re-throw `DOMException` unchanged.** Leaks Chromium-version-specific text into
  application error handling and provides no remediation.

## Consequences

### Positive
- Consumers learn one type and a documented list of codes.
- An error looks identical in every tab, which makes multi-tab support tractable.

### Negative
- A mapping table must be maintained as Chromium evolves. It is one file, exhaustively
  switch-checked by the compiler, with a documented fallback code for the unmapped case.

## Verification

Unit tests assert the mapping table, round-trip serialisation, cause chaining, and that every
code has a non-empty remediation string.
