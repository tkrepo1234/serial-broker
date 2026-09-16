# Coding Style

Formatting is not a matter of taste here: **Prettier owns it**, ESLint enforces the rest.
Never hand-format; never argue about it in review. `npm run format` is the final word.

## Non-negotiable formatting (enforced)

| Rule            | Value                               | Enforced by               |
| --------------- | ----------------------------------- | ------------------------- |
| Indentation     | 2 spaces, never tabs                | Prettier, `.editorconfig` |
| Line width      | 100 columns                         | Prettier                  |
| Quotes          | single, backticks for interpolation | Prettier                  |
| Semicolons      | always                              | Prettier                  |
| Trailing commas | all (multiline)                     | Prettier                  |
| Line endings    | LF                                  | `.gitattributes`          |
| File encoding   | UTF-8, no BOM                       | `.editorconfig`           |

## Naming

Following the Google TypeScript Style Guide:

| Kind                                            | Convention                         | Example                   |
| ----------------------------------------------- | ---------------------------------- | ------------------------- |
| Class, interface, type alias, enum              | `UpperCamelCase`                   | `PortSupervisor`          |
| Variable, parameter, function, method, property | `lowerCamelCase`                   | `reconnectDelayMs`        |
| Module-level constant (deeply immutable)        | `CONSTANT_CASE`                    | `DEFAULT_OPEN_TIMEOUT_MS` |
| Type parameter                                  | single capital or `UpperCamelCase` | `T`, `TPayload`           |
| File                                            | `kebab-case.ts`                    | `port-supervisor.ts`      |
| Test file                                       | `<unit-under-test>.test.ts`        | `port-supervisor.test.ts` |

Additional rules:

- **No abbreviations that are not universally known.** `config`, `id`, `ms`, `utf8` are fine;
  `prtSup`, `cfgMgr`, `msgHdlr` are not.
- **Units belong in the name.** Any numeric time, size or rate carries its unit suffix:
  `timeoutMs`, `bufferSizeBytes`, `baudRate`. A bare `timeout` is a review blocker.
- **Booleans read as assertions.** `isOpen`, `hasPendingWrites`, `shouldReconnect` — never
  `open`, `pending`, `reconnect`.
- **No Hungarian notation, no `_`-prefixed privates.** Use `#private` fields or `private`.
- **Names never carry runtime meaning.** Nothing in this library dispatches on an identifier
  string. Renaming a symbol must never change behaviour.

## File layout

Every source file follows this order, top to bottom:

1. Licence/file header comment (only where it carries information — no boilerplate banners).
2. `import` statements in groups — built-in, external, internal, parent, sibling — separated by a
   blank line and sorted alphabetically inside each group; enforced by `import-x/order`.
3. Module constants.
4. Types and interfaces.
5. The primary export (one concept per file).
6. Helpers, in call order, below their first use.

**One concept per file.** A file exporting two unrelated classes is split. Files above
400 lines are a smell and require a justification in review.

## Imports and module boundaries

- Always use ESM `import`/`export`. No `require`, no default exports except in a bundler
  entry point — named exports keep refactors mechanical and tree-shaking predictable.
- Use `import type { ... }` for type-only imports so the emitted JavaScript is obvious.
- **Layering is enforced by review** (see [Internals](../site/internals.md#layers)). The permitted
  direction is strictly downward:

  ```
  public facade  ->  client  ->  owner | storage | protocol  ->  core
                     owner   ->  protocol  ->  core
                     worker  ->  protocol  ->  core
                     storage ->  core
  ```

  `environment/` holds the platform interfaces that client, owner and storage import, and
  `environment/browser.ts` is the composition root that builds the client's transports. `core/`
  imports nothing from the layers above it. A circular import is a lint failure
  (`import-x/no-cycle`); the direction itself is kept in review.

- Import a module by its file. `src/index.ts` and `src/diagnostics.ts` gather exports for the
  package's consumers only; nothing inside the library imports through them. The two exceptions
  are `src/global.ts` and `src/global-diagnostics.ts`, the classic script builds' entry points:
  they are consumers, repackaging an entry point's surface onto one global, and taking it from the
  entry point is what makes the two the same surface by construction (ADR-0043).

## Language rules

- `const` by default, `let` only where reassignment is real, `var` never.
- Prefer `readonly` on fields and `ReadonlyArray<T>` on parameters that are not mutated.
- Strict equality (`===`) always. The single permitted exception is `x == null` to test
  "null or undefined", which must carry no comment because it is idiomatic.
- No `any` in committed code. Use `unknown` at trust boundaries and narrow explicitly.
  See [TypeScript](./typescript.md).
- Async: `async`/`await` everywhere; no bare `.then()` chains in application code. Every
  promise is either awaited, returned, or explicitly handed to `void promise.catch(...)`
  with a comment explaining why nobody awaits it.
- No classes where a function suffices, no inheritance where composition suffices. There is
  no abstract base class in this library and adding one requires an ADR.

## Comments

Comments explain **why**, never **what**. The code states what it does.

```ts
// Bad: increments the attempt counter
attempt += 1;

// Good: the first reconnect attempt must not be delayed — a power-cycled device is
// usually back within one event-loop turn, and waiting would show a visible outage.
if (attempt === 0) {
  return 0;
}
```

Every non-obvious concurrency decision carries a comment naming the race it prevents.
