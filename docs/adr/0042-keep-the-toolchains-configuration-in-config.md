# ADR-0042: Keep the toolchain's configuration in config/

- **Status:** Accepted
- **Date:** 2026-09-16

## Context

The repository root held 22 tracked files, and nine of them were a tool's configuration:
`.prettierrc.json`, `.prettierignore`, `tsup.config.ts`, `tsup.debug.config.ts`,
`typedoc.site.json`, `vitest.config.ts`, `playwright.config.ts`, `playwright.examples.config.ts`
and `eslint.config.js`. Beside them stood `tsconfig.json` and `tsconfig.build.json`. The library
itself — `src/`, `test/`, the documentation, the examples — was a minority of what the root
listing showed.

That is what a visitor sees first, on the repository page and in an editor's file tree, and it is
the wrong first impression: a reader looking for what this project _is_ must scroll past eight
answers to how it is built. The reduction inventory of 2026-09-15 already listed the project
directory as unaddressed work, noting that "the README does not describe the layout"
(`docs/reviews/2026-09-15-reduction-inventory.md`).

Nothing about these files requires the root. Each of these tools is started by an npm script, and
npm scripts run from the directory holding `package.json`, so a script can name a configuration
anywhere with a path flag. The root is where each tool _discovers_ its configuration when told
nothing — a default, not a requirement. The exceptions are the tools that are not started by our
scripts at all: an editor's language server, or ESLint's own search.

## Decision

**The toolchain's configuration moves to `config/`, and every npm script names its configuration
with a path flag.** Eight files move:

| Was                             | Now                                    | How it is found now                                             |
| ------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `.prettierrc.json`              | `config/prettier.json`                 | `prettier --config config/prettier.json`                        |
| `.prettierignore`               | `config/prettier-ignore`               | `--ignore-path .gitignore --ignore-path config/prettier-ignore` |
| `tsup.config.ts`                | `config/tsup.config.ts`                | `tsup --config config/tsup.config.ts`                           |
| `tsup.debug.config.ts`          | `config/tsup.debug.config.ts`          | `tsup --config config/tsup.debug.config.ts`                     |
| `typedoc.site.json`             | `config/typedoc.json`                  | `typedoc --options config/typedoc.json`                         |
| `vitest.config.ts`              | `config/vitest.config.ts`              | `vitest run --config config/vitest.config.ts`                   |
| `playwright.config.ts`          | `config/playwright.config.ts`          | `playwright test --config config/playwright.config.ts`          |
| `playwright.examples.config.ts` | `config/playwright.examples.config.ts` | `playwright test --config config/playwright.examples.config.ts` |

The root keeps 14 files. `config/README.md` says what is in the directory and repeats the reasons
below, for a reader who opens `config/` rather than this record.

**Prettier's ignore list was the one genuinely dangerous part of this move**, and it failed twice
before it was right. Both failures are silent: they do not error, they quietly widen what Prettier
rewrites.

1. `--ignore-path` **replaces** Prettier's default, which is _two_ files, `.gitignore` and
   `.prettierignore`. Naming only the moved list would have started formatting `dist/`,
   `coverage/` and every example's `node_modules/`. The flag is therefore given twice, `.gitignore`
   first.
2. The file's patterns follow `.gitignore` rules, under which **a pattern containing a slash is
   anchored to the directory holding the ignore file**. Moved unchanged into `config/`,
   `docs/site/_generated` came to mean `config/docs/site/_generated` and matched nothing. Every
   slash-bearing pattern silently stopped applying, and the first `npm run format` after the move
   reformatted seven generated files that are written by tools and committed as records:
   `docs/site/_generated/` (three), `bench/results/` (two) and both extreme-suite `RESULTS.md`.
   `package-lock.json`, which has no slash and so matches at any depth, was unaffected — which is
   precisely why spot-checking one file would have missed this. Each slash-bearing pattern now
   starts with `../`; `package-lock.json` stays unanchored, because anchoring it would newly have
   caught every example's own lockfile.

The guard against both is a comparison, not a reading: the set of files Prettier matches was
captured before the move and after it, and differs only by the configurations that moved and the
two files this change adds.

**Relative paths inside a configuration do not all mean the same thing**, and this is the trap the
move sets for whoever edits these files next:

- Playwright resolves `testDir`, `outputDir` and `webServer.cwd` against the **configuration
  file's** directory. Both Playwright configurations gained `../` on `testDir`, an explicit
  `outputDir: '../test-results'` so traces stay where CI collects them and `.gitignore` expects
  them, and — for the browser suite — `cwd: '..'` so the static server still starts from the root.
  `playwright.examples.config.ts` also builds its list of examples from `import.meta.dirname`,
  which now needs `'..'`.
- TypeDoc resolves `entryPoints` and `out` against the **options file's** directory, so both
  gained `../`. This was confirmed by running it, not assumed.
- tsup and esbuild resolve `entry` and `inject` against the **working directory**, which is the
  root. Those paths are unchanged, and a comment now says why.
- Vitest would take its root from the working directory. Rather than depend on that,
  `config/vitest.config.ts` states `root` outright, so the `include` globs and the coverage
  `include`, `exclude` and per-directory thresholds keep meaning what they say.

**`bench/browser/playwright.config.ts` stays where it is.** It is the benchmark's, not the
toolchain's: it sits with the scenarios it runs and is already named by its script.

### What stays in the root, and why each could not move

- **`package.json`, `package-lock.json`** — npm reads them from the root and accepts no other
  location. Everything else in this decision depends on that being true.
- **`tsconfig.json`, `tsconfig.build.json`** — an editor's TypeScript language server finds a
  project by walking _up_ from the file being edited; moving the root project would leave every
  file in `src/` without one until each editor was configured by hand. `bench/tsconfig.json`,
  `emulator/tsconfig.json` and `docs/site/examples/code/tsconfig.json` extend it by relative path,
  and `tsc -p` is handed it by name. Its `include` changed `"*.config.ts"` to `"config/*.ts"` so
  the moved TypeScript configurations stay type-checked and type-aware linting still resolves them.
- **`eslint.config.js`** — ESLint 10 searches for `eslint.config.*` from the working directory
  upwards. There is no flag that makes that search look in a subdirectory, and `--config` would
  have to be repeated on every invocation including every editor integration's.
- **`.editorconfig`** — editors look up the directory tree from the open file, as with tsconfig.
- **`.gitattributes`, `.gitignore`** — Git's own, and Git looks in the root.
- **`LICENSE`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `BACKLOG.md`** —
  these are the point. They are what the root should be showing.

## Alternatives considered

- **Leave it as it is.** The root is conventional: every tool's documentation shows its
  configuration there, and a contributor finds `vitest.config.ts` without being told. Rejected
  because the convention is a default rather than a requirement, and because the cost it imposes —
  the project's own files outnumbered by its toolchain's, on the first screen every visitor sees —
  is paid by many readers while the benefit accrues to the few who edit a tool's settings. Those
  few now find a directory named for exactly what it holds.
- **Move the settings into `package.json` keys.** Prettier, and several of the others, read
  configuration from a key in `package.json`. This removes files from the root outright rather than
  relocating them. Rejected on three counts: tsup, Vitest and Playwright configurations are
  TypeScript with imports, comments and computed values — `playwright.examples.config.ts` reads
  the filesystem — and cannot become JSON at all; the long explanatory comments in
  `vitest.config.ts` and `playwright.config.ts`, which are the reason those thresholds and timeouts
  can be reviewed, have nowhere to live in JSON; and it would grow `package.json` into the single
  file every change touches.
- **A dotfile directory, `.config/`.** Hidden from a plain listing, which is tidier still.
  Rejected: a directory a contributor has to know about before they can see it is worse than one
  named in the README's layout table, and dotfiles are already the part of the root that reads as
  clutter.
- **Move `tsconfig.json` too, leaving a root stub that extends it.** The stub would be a root file
  that exists only to point elsewhere — the count unchanged and a layer of indirection added.
- **Move `eslint.config.js` and pass `--config` in the lint script.** The script would work; every
  editor's ESLint integration, which runs its own search, would silently stop finding the rules.
  A lint that passes in the editor and fails in CI is worse than a file in the root.

## Consequences

### Positive

- The root lists 14 files instead of 22, and eight of the nine remaining non-source entries are
  documents a reader wants (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`,
  `BACKLOG.md`, `LICENSE`) rather than settings.
- A tool's configuration is now found by looking in one named place, instead of by knowing which
  dotfile belongs to which tool.
- `config/README.md` gives the toolchain a single description, which no file previously held.

### Negative

- **Every tool now needs its path flag.** `tsup`, `vitest`, `playwright` and `prettier` all
  discover a root configuration on their own, and each will run with _defaults_ rather than fail if
  its flag is missing. A new script, or a tool invoked by hand, that forgets the flag does not
  error — it quietly does the wrong thing. `scripts/test-extreme.mjs`, which spawns Vitest itself,
  needed the flag for exactly this reason.
- Running a tool ad hoc is longer to type: `npx vitest run` is no longer enough.
- Two ways of resolving a relative path now coexist in one directory, per the Decision above.

### Risks and mitigations

- A future contributor adds a tool and leaves its configuration in the root, and the root drifts
  back. `config/README.md` states the rule, and this record is the reason.
- Prettier's ignore list is the one place where a missing flag is silently destructive rather than
  merely wrong. It is covered by the verification below.

## Verification

`npm run verify` (format, lint, type-check, coverage-gated tests, build), `npm run test:browser`
and `npm run test:examples` all pass with the moved configurations, which is what exercises every
path flag: `test:examples` runs through `config/playwright.examples.config.ts`, and the build runs
through both tsup configurations.

Two comparisons were made rather than assumed, because a wrong answer to either would have been
silent:

- The set of files Prettier matches was captured before and after the move and is identical, 457
  files, `package-lock.json` and every other entry of the old `.prettierignore` still excluded.
- `npm run test:coverage` reports the same files and the same per-directory thresholds as before.

`npm run docs` was not run: it needs the Python environment at `docs/.venv` (ADR-0020), which this
working tree does not have. TypeDoc itself was run directly against `config/typedoc.json`, which is
how its path resolution was established.

## History

- 2026-09-16: Accepted — eight of the root's nine tool configurations moved to `config/`;
  `eslint.config.js`, the tsconfigs and `.editorconfig` stay where their tools search.
