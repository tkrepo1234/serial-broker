# TypeScript Rules

The compiler is the first reviewer. Its configuration is deliberately maximal; weakening a
compiler flag requires an ADR.

## Mandatory compiler settings

`tsconfig.json` enables, and no file may opt out of:

| Flag                                       | Why                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| `strict`                                   | All of the strict family. Non-negotiable.                                      |
| `noUncheckedIndexedAccess`                 | `array[i]` is `T \| undefined`. Prevents a whole bug class in buffer handling. |
| `exactOptionalPropertyTypes`               | `{ a?: string }` cannot be assigned `undefined` explicitly — forces intent.    |
| `noImplicitOverride`                       | Every override is declared.                                                    |
| `noFallthroughCasesInSwitch`               | State machines are switch-heavy; fallthrough is always a bug here.             |
| `noImplicitReturns`                        | Every branch of a status-computing function returns.                           |
| `noPropertyAccessFromIndexSignature`       | Keeps dynamic lookups visibly dynamic.                                         |
| `useUnknownInCatchVariables`               | Caught values are `unknown` until narrowed.                                    |
| `isolatedModules` / `verbatimModuleSyntax` | Guarantees the source is transpilable file-by-file.                            |

## Bans

- **`any` is banned in committed source.** Use `unknown` and narrow. If a third-party type
  forces it, isolate it behind a single adapter function with an
  `// eslint-disable-next-line` and a comment naming the upstream type.
- **Non-null assertion `!` is banned** except in a line immediately preceded by a comment
  proving the invariant, or in test code.
- **`as` casts are a last resort.** Prefer a user-defined type guard
  (`function isX(v: unknown): v is X`). Casting the result of `JSON.parse` straight into a
  domain type is a review blocker — parse and validate.
- **`enum` is banned** (it emits runtime code and has surprising semantics). Use:

  ```ts
  export const SerialBrokerStatus = {
    Idle: 'idle',
    Connecting: 'connecting',
  } as const;
  export type SerialBrokerStatus = (typeof SerialBrokerStatus)[keyof typeof SerialBrokerStatus];
  ```

  This gives a runtime value object, a string-literal union type, and zero surprises when
  the value crosses a `postMessage` boundary.

- **`namespace` is banned.** Modules are the unit of encapsulation.

## Type-design rules

- **Model states as discriminated unions, not as optional fields.** A connection is
  `{ status: 'open'; port: SerialPort }` or `{ status: 'reconnecting'; attempt: number }` —
  never `{ status: string; port?: SerialPort; attempt?: number }`. The compiler must be able
  to prove that `port` exists exactly when the status says so.
- **Make illegal states unrepresentable** before adding a runtime check for them.
- **Public option objects are `interface`s with all fields documented in TSDoc.** Internal
  shapes may be `type` aliases.
- **Freeze what you hand out and keep.** Status snapshots and error contexts are `Readonly<...>` in
  the type system and frozen at runtime. Event payloads are `readonly` in the type system, and
  their `data` is a copy the receiver may keep or change.
  See [Defensive Programming](./defensive-programming.md).
- **Never widen the public surface accidentally.** Everything exported from `src/index.ts` is
  public API covered by SemVer. Internal symbols are not exported from the entry point, even
  if they are exported from their own module.
- **Branded IDs.** Opaque identifiers (client id, request id) use branded string types so a
  request id can never be passed where a client id is expected.

## Message-boundary types

Anything crossing `postMessage`, `localStorage` or a `SharedWorker` port is untyped at
runtime. The rule is absolute:

> Values arriving from another context are `unknown` and must pass a validating parser
> before any field is read.

The wire format is versioned and lives in `src/protocol/`. See
[ADR-0007](../adr/0007-wire-protocol-and-versioning.md).
