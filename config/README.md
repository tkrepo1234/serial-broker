# Toolchain configuration

The configuration of the tools that build, format, test and document this library. It lives here
rather than in the repository root so that what a visitor sees first is the project and not its
toolchain ([ADR-0042](../docs/adr/0042-keep-the-toolchains-configuration-in-config.md)).

| File                            | Tool                          | Invoked by                                                  |
| ------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| `prettier.json`                 | Prettier                      | `npm run format`, `npm run format:check`                    |
| `prettier-ignore`               | Prettier's ignore list        | the same, as a second `--ignore-path` after `.gitignore`    |
| `tsup.config.ts`                | tsup: the published bundles   | `npm run build`                                             |
| `tsup.debug.config.ts`          | tsup: the debugging surface   | `npm run build`                                             |
| `vitest.config.ts`              | Vitest and its coverage gates | `npm test`, `npm run test:coverage`, `npm run test:extreme` |
| `playwright.config.ts`          | the browser suite             | `npm run test:browser`                                      |
| `playwright.examples.config.ts` | the examples' smoke tests     | `npm run test:examples`                                     |
| `typedoc.json`                  | the API reference             | `npm run docs`                                              |

Every one of these is reached through an npm script that names it with a path flag; none of these
tools discovers a configuration outside the root on its own. A new tool's configuration belongs
here, with its script carrying the flag.

**Paths inside these files do not all mean the same thing.** Playwright resolves `testDir`,
`outputDir` and `webServer.cwd` against this directory; TypeDoc resolves `entryPoints` and `out`
against this directory; tsup and esbuild resolve `entry` and `inject` against the working
directory, which is the repository root. `vitest.config.ts` states its `root` outright rather than
leave the question open. Check which rule applies before adding a path.

**`prettier-ignore` is the sharp edge.** It follows `.gitignore` rules, so a pattern containing a
slash is anchored to _this_ directory, not to the repository root: written plainly,
`docs/site/_generated` means `config/docs/site/_generated` and matches nothing at all. Every
slash-bearing pattern in it therefore starts with `../`. A pattern without a slash, such as
`package-lock.json`, matches at any depth and must stay unanchored. Getting this wrong does not
fail — it quietly lets `npm run format` rewrite generated files that are committed as records, so
after changing that file, run `npm run format` and check that `git status` is clean.

## What stays in the repository root, and why

- **`package.json`, `package-lock.json`** — npm looks for them there and nowhere else.
- **`tsconfig.json`, `tsconfig.build.json`** — editors and language servers find a project by
  walking up from the file being edited, `tsc -p` is given them by name, and `bench/`,
  `emulator/` and `docs/site/examples/code/` extend `tsconfig.json` by relative path.
- **`eslint.config.js`** — ESLint 10 searches for `eslint.config.*` from the working directory
  upwards and has no flag that would make it look here.
- **`.editorconfig`** — read by editors, which look up the directory tree from the open file.
- **`.gitattributes`, `.gitignore`** — Git's, not the toolchain's.
