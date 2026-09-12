# Defensive Programming

This library sits between untrusted application code, a browser API that can fail at any
moment, physical hardware that can be unplugged mid-write, and other browser tabs that can
disappear without notice. It must never enter an undefined state.

## Trust boundaries

There are exactly four, and each has a mandatory discipline:

| #   | Boundary                                                     | Discipline                                                                                                                               |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Application → library** (public API calls)                 | Validate every argument eagerly and throw a typed error with a remediation hint. Never coerce silently.                                  |
| 2   | **Other contexts → library** (`postMessage` from worker/tab) | Parse with a validating decoder. Unknown or malformed messages are dropped and reported, never partially applied.                        |
| 3   | **Persistence → library** (`localStorage`)                   | Treat stored JSON as hostile: it may be from an older version, hand-edited, or truncated. Validate, then migrate or discard.             |
| 4   | **Web Serial / hardware → library**                          | Assume every call can reject, hang forever, or resolve after the object is already stale. Everything gets a timeout and a disposal path. |

## Rules

### Validate at the boundary, trust inside

Validation happens **once**, at the boundary, in a dedicated module (`core/validation.ts`,
`protocol/decode.ts`, `storage/registry.ts`). Internal functions may assume their inputs are
valid and express that assumption with `assert(...)` — which throws an
`InternalInvariantError`, because a violated internal invariant is a library bug, not a user
error.

```ts
// Boundary: full validation, user-facing error.
export function normalizeOptions(input: unknown): NormalizedOptions { ... }

// Interior: invariant assertion, bug-facing error.
function write(state: OpenState, chunk: Uint8Array): Promise<void> {
  assertInvariant(state.status === 'open', 'write() requires an open connection');
  ...
}
```

### Every await can hang — bound it

Web Serial calls (`open`, `close`, `writer.write`, `reader.read`) have been observed to never
settle when a device is yanked mid-transfer. **Every external promise is wrapped in a
deadline** (`core/deadline.ts`). A timeout is a normal, reported outcome, not an exception to
the design.

### Every resource has exactly one owner and one disposal path

Readers, writers, locks, worker ports, timers and event listeners are acquired through a
`Disposable` that is registered with the owning object's disposal stack. Disposal is:

- **idempotent** — calling `dispose()` twice is legal and does nothing the second time;
- **exception-safe** — a throwing disposer never prevents the remaining disposers running;
- **ordered** — last acquired, first released.

### Never trust your own past self across contexts

A tab that was master 20 ms ago may not be master now. Any operation on the physical port
re-checks ownership immediately before the effectful call, and the ownership token is
passed explicitly rather than read from mutable module state.

### Idempotency and re-entrancy

Public methods are idempotent where the semantics allow it (`setup` with identical options is
a no-op, `release` on an unknown name is a no-op) and re-entrancy safe: calling `send()` from
inside an `onReceive` handler must not corrupt state. Event dispatch therefore iterates over a
**copy** of the listener set, and listener exceptions are caught and reported through
`onError` — one misbehaving application handler must never stop delivery to the others.

### Numbers and buffers

- Validate numeric ranges explicitly (`baudRate > 0`, `vendorId` within `0x0000..0xffff`).
  Reject `NaN`, `Infinity` and non-integers where an integer is required.
- Never hand out a view onto an internal buffer. Copy on the way out; the application may
  retain or mutate what it receives.
- Never assume a `read()` returns a complete logical message. Framing is explicitly **not**
  this library's job (see [ADR-0002](../adr/0002-scope-transport-only.md)); chunks are
  delivered as they arrive.

### Forbidden patterns

- `catch { }` — an empty catch without a comment justifying why the error is truly
  uninteresting.
- `setTimeout` without storing and clearing the handle.
- Reading mutable module-level state inside an async continuation without re-validating it.
- Throwing from an event handler, a disposer, or a `postMessage` handler.
- `JSON.parse` without a subsequent validation step.
