# ADR-0044: Correct the UI5 import-meta plugin in the two OpenUI5 examples

- **Status:** Accepted
- **Date:** 2026-09-16

## Context

Both OpenUI5 examples stopped loading: `Component.create() failed - ModuleError: Failed to resolve
dependencies`, and their smoke tests went red. The cause is one line in a development dependency,
`ui5-tooling-modules`, which bundles npm packages into UI5 modules.

Its import-meta plugin inspects every `new URL(…, import.meta.url)` in a bundled package, so that
the file it points at is emitted beside the bundle. serial-broker has exactly one: the worker
script it must find at a stable URL ([ADR-0006](./0006-sharedworker-as-message-broker.md)). The
plugin means to strip a query string from the resolved path and asks:

```js
if (resolvedModuleId.indexOf('?')) {
  resolvedModuleId = resolvedModuleId.substring(0, resolvedModuleId.indexOf('?'));
}
```

`indexOf` returns `-1` when there is no query string, and `-1` is truthy. A path without a query -
the ordinary case - is therefore cut to the empty string, and the plugin then calls `readFileSync('')`.
The bundle fails, the component never resolves, and the page shows nothing.

This is a bug in someone else's package, in a code path any dependency with an `import.meta.url`
URL reaches. It is not something the library can hold differently: dropping the construct would
mean giving up the worker URL the whole design rests on. Three ways out were open.

**Change the examples so the plugin is never used** - have them load the library through an import
map instead of letting UI5 Tooling bundle it. That hides the failure by making the examples
unrepresentative: an import map is precisely what a UI5 project does not write, and `examples/no-bundler`
already shows that path.

**Accept it and mark the two examples known-red.** Honest, but a red example is a broken example
to anyone who finds the repository, and it would stay broken for as long as the package does.

**Correct the line locally, in each example's own `node_modules`.**

## Decision

Each OpenUI5 example carries `scripts/fix-ui5-tooling-modules.mjs` and runs it from its existing
`prestart` and `prebuild` hooks, beside the script that copies the worker in. It replaces that one
condition with `indexOf('?') !== -1` - what the plugin's own comment says it wants - in the copy
installed under that example.

The script is deliberately narrow and loud:

- it touches one file, in one package, inside the example's own `node_modules`, and nothing else;
- it prints what it did on every start;
- it is idempotent, and says so when the line is already corrected;
- when neither form is found, the package has been rewritten - very likely fixed - and the script
  leaves it alone and reports that instead of failing.

No `patch-package`, no new dependency, no `postinstall` in a published package: the examples are
private and self-contained, and the correction has to hold in a fresh CI checkout, where `npm ci`
reinstalls the dependency each time.

## Consequences

Both examples run and both smoke tests pass, with the examples written the way a UI5 project is
actually written - `ui5-tooling-modules` doing the bundling, the library imported by package name.

A reader of the examples sees a script whose comment explains a defect in a third-party package.
That is a cost, and the right one: the alternative was a silently unrepresentative example or a
red one.

The correction disappears by itself. When the package ships the fix, the script finds neither form,
says so, and can be deleted along with the two hook entries - nothing else in either example refers
to it.

Nothing about the library changes. This is an example-level workaround for an example-level build
tool; the published package, its files and its worker URL are untouched.
