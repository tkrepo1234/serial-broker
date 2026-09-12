# Error Handling and Enhanced Error Reporting

A hardware library whose error message is `TypeError: Failed to execute 'open'` has failed its
user. Every error this library produces answers three questions: **what went wrong**,
**where in the system**, and **what to do about it**.

## The error object

All errors thrown or reported by this library are instances of `SerialBrokerError`:

```ts
class SerialBrokerError extends Error {
  readonly code: SerialBrokerErrorCode;   // stable, machine-readable, documented
  readonly configName: string | undefined; // which configuration it relates to
  readonly context: Readonly<Record<string, unknown>>; // structured, serialisable detail
  readonly remediation: string;            // what the developer should do
  readonly isRetryable: boolean;           // whether the library will retry on its own
  readonly timestamp: number;              // epoch ms, from the injected clock
  readonly cause?: unknown;                // the underlying error, per ES2022
  toJSON(): SerializedSerialBrokerError;   // survives postMessage and logging pipelines
}
```

Rules:

- **`code` is API.** Codes are `SCREAMING_SNAKE_CASE`, listed in `src/core/error-codes.ts`
  and documented in the README. Renaming or repurposing a code is a breaking change; adding
  one is not.
- **`message` is for humans, `code` is for machines.** Never parse a message. Message text
  may change in a patch release.
- **`remediation` is mandatory and specific.** "Check your configuration" is not remediation.
  "Call SerialBroker.requestAccess('CardReader') from a click handler; the browser only
  grants serial access during a user gesture" is.
- **`context` must be structurally cloneable** — it crosses `postMessage` and goes into logs.
  No DOM nodes, no functions, no `SerialPort` instances.
- **Always chain.** When wrapping a lower-level failure, pass the original as `cause`. Never
  discard it.

## Throw vs. report

| Situation | Mechanism |
| --- | --- |
| The caller made a mistake (bad arguments, unknown name, calling before `setup`) | **Throw** synchronously or reject the returned promise. Fail fast and loudly. |
| The environment is missing a feature (no Web Serial, no `SharedWorker`) | **Throw** from `setup()` with a code the caller can branch on. |
| Something went wrong asynchronously and the library is handling it (device unplugged, reconnect attempt failed, peer tab vanished) | **Report** through the `onError` event. Never throw into the void — an unhandled rejection in a background task is a bug. |
| An internal invariant is violated | Throw `InternalInvariantError` *and* report it. This is a library bug and must be loud in both channels. |

A failure that is both caller-visible and background-relevant (a `send()` that fails because
the device is gone) does both: the returned promise rejects **and** an `onError` event fires,
so that other tabs learn about it too.

## Never swallow, never double-report

- An error crosses the `onError` channel exactly once per occurrence per tab. The master does
  not re-broadcast an error that the origin tab already received directly.
- Errors from application event listeners are caught, wrapped with code
  `LISTENER_THREW`, and reported — but never rethrown into the library's own control flow.
- Errors during disposal are collected and reported as a single `AggregateError`-shaped
  context. Disposal never fails.

## Logging

The library ships a `Logger` interface and logs **nothing** by default — a library that
writes to the host application's console uninvited is a bad citizen. Applications opt in via
`SerialBroker.configure({ logger })`.

Log levels and what belongs in them:

| Level | Content |
| --- | --- |
| `error` | Only conditions that also produced a `SerialBrokerError`. |
| `warn` | Recovered anomalies: retry succeeded, malformed peer message dropped, stale state discarded. |
| `info` | Lifecycle milestones: configuration registered, port opened, master role acquired/lost. |
| `debug` | Protocol traffic, state transitions, timer scheduling. Verbose by design. |

Every log record carries `{ configName, clientId, event }` so records from several tabs can be
correlated in one console. **Never log payload bytes at `info` or above** — serial traffic can
contain card numbers, PINs or other secrets. Payload logging exists only at `debug` and only
as a byte count unless `logPayloads: true` is explicitly configured.
