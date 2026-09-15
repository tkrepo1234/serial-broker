# ADR-0020: Build the developer documentation with Sphinx, MyST and a TSDoc-generated reference

- **Status:** Accepted
- **Date:** 2026-09-13

## Context

The README is a decision aid and the ADRs record reasoning; neither teaches use. The requirement
(`BACKLOG.md`, 2026-09-12) is product-grade developer documentation modelled on
[open62541 1.3](https://www.open62541.org/doc/1.3/): Sphinx with the Read the Docs theme, an
introduction, tutorials, chapters that explain behaviour, and every API function documented in
full.

Three things had to be settled first:

- **Sphinx is Python; this repository is Node.** Python 3 is available on development machines,
  but nothing in the repository needed it so far.
- **Where the API reference comes from.** open62541 extracts it from comments in its C headers.
  This library's exports already carry TSDoc comments, written to a documented standard
  (`docs/guidelines/documentation.md`), and typedoc already reads them.
- **Markup.** open62541 writes reStructuredText. Everything else in this repository is Markdown.

## Decision

- **Sphinx with `sphinx_rtd_theme`**, the theme open62541 1.3 uses, built from `docs/site/`.
- **Chapters in Markdown**, through MyST, so they read like every other document in the
  repository.
- **The API reference is generated from TSDoc** by typedoc with `typedoc-plugin-markdown` into
  `docs/site/api/reference/` at build time, and never committed. Gaps in the reference are closed
  in the source comments, not in the site.
- **Python lives in a virtual environment at `docs/.venv`**, created from pinned
  `docs/site/requirements.txt`, so the repository itself does not depend on Python.
  `npm run docs` runs typedoc and then Sphinx, and fails on any warning.
- **CI builds the site** in a job of its own, with the same virtual environment, and keeps the built
  HTML as an artefact.

## Alternatives considered

- **reStructuredText, as open62541.** Closer to the model, but a second markup language in one
  repository, and less familiar to the TypeScript developers who read and write these pages.
  The theme, which is what makes the site look like open62541's, is the same either way.
- **A hand-written API reference.** Full control over structure and tone, and certain to drift
  from the signatures with every change. Rejected; the chapters around the reference are where
  hand-written prose belongs.
- **A Node documentation generator (VitePress, Docusaurus, typedoc's own HTML).** No Python, but
  not Sphinx and not the Read the Docs theme, which are the requirement.

## Consequences

### Positive

- The reference cannot disagree with the code it documents.
- Writing documentation stays Markdown throughout.
- A broken page or cross-reference fails the build on push, not only locally.

### Negative

- Building the site needs Python and a one-time `pip install`. Nothing else in the repository does.
- The reference is only as good as the TSDoc comments; completing them is part of the work.

## Verification

`npm run docs` builds `docs/site/_build/html/` from a clean checkout with the environment created;
the `docs` job in `.github/workflows/ci.yml` runs it on every push.

## History

- 2026-09-13: Accepted, with the site not yet built in CI.
- 2026-09-15: CI builds the site (recorded; the job already existed).
