# ADR-0025: Keep the toolchain's configuration in config/

- **Status:** Accepted

## Context

A build, a formatter, a test runner, a browser test runner and a documentation generator each bring
a configuration file, and each tool's documentation puts that file in the repository root. With all
of them there, the library itself - `src/`, `test/`, the documentation, the examples - is a minority
of what the root listing shows.

The root is what a visitor sees first, on the repository page and in an editor's file tree, and a
root full of configuration is the wrong first impression: a reader looking for what this project
_is_ must scroll past the answers to how it is built.

Nothing about these files requires the root. Each of these tools is started by an npm script, and
npm scripts run from the directory holding `package.json`, so a script can name a configuration
anywhere with a path flag. The root is where each tool _discovers_ its configuration when told
nothing - a default, not a requirement. The exceptions are the tools that are not started by our
scripts at all: an editor's language server, or ESLint's own search.

## Decision

**The toolchain's configuration lives in `config/`, and every npm script names its configuration
with a path flag.**

| File                                   | How it is found                                                 |
| -------------------------------------- | --------------------------------------------------------------- |
| `config/prettier.json`                 | `prettier --config config/prettier.json`                        |
| `config/prettier-ignore`               | `--ignore-path .gitignore --ignore-path config/prettier-ignore` |
| `config/tsup.config.ts`                | `tsup --config config/tsup.config.ts`                           |
| `config/tsup.debug.config.ts`          | `tsup --config config/tsup.debug.config.ts`                     |
| `config/typedoc.json`                  | `typedoc --options config/typedoc.json`                         |
| `config/vitest.config.ts`              | `vitest run --config config/vitest.config.ts`                   |
| `config/playwright.config.ts`          | `playwright test --config config/playwright.config.ts`          |
| `config/playwright.examples.config.ts` | `playwright test --config config/playwright.examples.config.ts` |
| `config/tsconfig.build.json`           | `tsc -p config/tsconfig.build.json`                             |

`config/README.md` says what is in the directory and repeats the reasons below, for a reader who
opens `config/` rather than this record.

**Prettier's ignore list is the one genuinely dangerous part**, because both ways of getting it
wrong are silent: they do not error, they quietly widen what Prettier rewrites.

1. `--ignore-path` **replaces** Prettier's default, which is _two_ files, `.gitignore` and
   `.prettierignore`. Naming only `config/prettier-ignore` would format `dist/`, `coverage/` and
   every example's `node_modules/`. The flag is therefore given twice, `.gitignore` first.
2. The file's patterns follow `.gitignore` rules, under which **a pattern containing a slash is
   anchored to the directory holding the ignore file**. Written plainly, `docs/site/_generated`
   means `config/docs/site/_generated` and matches nothing, and `npm run format` would reformat the
   generated files that are written by tools and committed as records: `docs/site/_generated/`,
   `bench/results/` and both extreme-suite `RESULTS.md`. Each slash-bearing pattern therefore starts
   with `../`. `package-lock.json`, which has no slash and so matches at any depth, stays
   unanchored, because anchoring it would catch every example's own lockfile - and because it
   behaves differently, checking that one file says nothing about the others.

**Relative paths inside a configuration do not all mean the same thing**, and this is the trap the
directory sets for whoever edits these files:

- Playwright resolves `testDir`, `outputDir` and `webServer.cwd` against the **configuration
  file's** directory. Both Playwright configurations carry `../` on `testDir`, an explicit
  `outputDir: '../test-results'` so traces are where CI collects them and `.gitignore` expects
  them, and - for the browser suite - `cwd: '..'` so the static server starts from the root.
  `playwright.examples.config.ts` builds its list of examples from `import.meta.dirname` and `'..'`.
- TypeDoc resolves `entryPoints` and `out` against the **options file's** directory, so both
  carry `../`.
- tsup and esbuild resolve `entry` and `inject` against the **working directory**, which is the
  root. Those paths are written from the root, and a comment says why.
- Vitest would take its root from the working directory. Rather than depend on that,
  `config/vitest.config.ts` states `root` outright, so the `include` globs and the coverage
  `include`, `exclude` and per-directory thresholds mean what they say.

**`bench/browser/playwright.config.ts` is not part of this.** It is the benchmark's, not the
toolchain's: it sits with the scenarios it runs and is named by its script.

### What is in the root, and why each has to be

- **`package.json`, `package-lock.json`** - npm reads them from the root and accepts no other
  location. Everything else in this decision depends on that being true.
- **`tsconfig.json`** - an editor's TypeScript language server finds a project by walking _up_ from
  the file being edited; a root project elsewhere would leave every file in `src/` without one until
  each editor was configured by hand. `bench/tsconfig.json`, `emulator/tsconfig.json` and
  `docs/site/examples/code/tsconfig.json` extend it by relative path, and `tsc -p` is handed it by
  name. `tsconfig.build.json`, which only the build's `tsc -p` reads, is in `config/` with the rest.
  The root project's `include` names `config/*.ts`, so the TypeScript configurations are
  type-checked and type-aware linting resolves them.
- **`eslint.config.js`** - ESLint 10 searches for `eslint.config.*` from the working directory
  upwards. There is no flag that makes that search look in a subdirectory, and `--config` would
  have to be repeated on every invocation including every editor integration's.
- **`.editorconfig`** - editors look up the directory tree from the open file, as with tsconfig.
- **`.gitattributes`, `.gitignore`** - Git's own, and Git looks in the root.
- **`LICENSE`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `BACKLOG.md`,
  `llms.txt`** - these are the point. They are what the root should be showing.

## Alternatives considered

- **Every configuration in the root.** The root is conventional: every tool's documentation shows
  its configuration there, and a contributor finds `vitest.config.ts` without being told. Rejected
  because the cost of that convention is paid by many readers while its benefit accrues to the few
  who edit a tool's settings, and those few find a directory named for exactly what it holds.
- **Settings in `package.json` keys.** Prettier, and several of the others, read configuration from
  a key in `package.json`, which takes files out of the root outright. Rejected on three counts:
  tsup, Vitest and Playwright configurations are TypeScript with imports, comments and computed
  values - `playwright.examples.config.ts` reads the filesystem - and cannot become JSON at all; the
  long explanatory comments in `vitest.config.ts` and `playwright.config.ts`, which are the reason
  those thresholds and timeouts can be reviewed, have nowhere to live in JSON; and it would grow
  `package.json` into the single file every change touches.
- **A dotfile directory, `.config/`.** Hidden from a plain listing, which is tidier still.
  Rejected: a directory a contributor has to know about before they can see it is worse than one
  named in the README's layout table, and dotfiles are the part of a root that reads as clutter.
- **`tsconfig.json` in `config/` too, with a root stub that extends it.** The stub would be a root
  file that exists only to point elsewhere - the count unchanged and a layer of indirection added.
- **`eslint.config.js` in `config/`, with `--config` in the lint script.** The script would work;
  every editor's ESLint integration, which runs its own search, would silently stop finding the
  rules. A lint that passes in the editor and fails in CI is worse than a file in the root.

## Consequences

### Positive

- The root lists the documents a reader wants, and the files a tool requires there.
- A tool's configuration is found by looking in one named place, instead of by knowing which
  dotfile belongs to which tool.
- `config/README.md` gives the toolchain a single description.

### Negative

- **Every tool needs its path flag.** `tsup`, `vitest`, `playwright` and `prettier` all discover a
  root configuration on their own, and each will run with _defaults_ rather than fail if its flag is
  missing. A script, or a tool invoked by hand, that forgets the flag does not error - it quietly
  does the wrong thing. `scripts/test-extreme.mjs`, which spawns Vitest itself, carries the flag for
  exactly this reason.
- Running a tool ad hoc is longer to type: `npx vitest run` is not enough.
- Two ways of resolving a relative path coexist in one directory, per the Decision above.

### Risks and mitigations

- A contributor adds a tool and leaves its configuration in the root, and the root fills up.
  `config/README.md` states the rule, and this record is the reason.
- Prettier's ignore list is the one place where a mistake is silently destructive rather than
  merely wrong. `npm run format` on a clean checkout changes nothing; after a change to the list,
  that is the check.

## Verification

`npm run verify` (format, lint, type-check, coverage-gated tests, build), `npm run test:browser`
and `npm run test:examples` exercise every path flag: `test:examples` runs through
`config/playwright.examples.config.ts`, and the build runs through both tsup configurations and
`config/tsconfig.build.json`.
