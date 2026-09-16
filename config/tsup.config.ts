import { defineConfig, type Options } from 'tsup';

/** Settings every published file is built with. */
const common = {
  target: 'es2022',
  platform: 'browser',
  // Declarations come from `tsc` rather than from the bundler: tsup's dts step runs its own
  // TypeScript configuration, and emitting them from the real one keeps the published types
  // identical to the ones the test suite type-checks against.
  dts: false,
  sourcemap: true,
  splitting: false,
  // No `treeshake`: it runs Rollup over esbuild's output, which appends a second
  // `sourceMappingURL` comment to every file and rewrites `import.meta.url` for CommonJS into a
  // guess relative to the page. esbuild already drops unused code when it bundles.
} satisfies Options;

/**
 * Every published file is named after the package, not after the entry file it was built from:
 * `serial-broker.js`, `serial-broker.min.js`, `serial-broker.global.js`,
 * `serial-broker.worker.js`. Someone copying one of these onto a web server can see what it is,
 * which `index.min.js` did not say (ADR-0043). The entry *keys* below carry those names; the
 * source files keep the conventional `src/index.ts` and `src/diagnostics.ts`, and
 * `scripts/entry-declarations.mjs` renames the two declarations `tsc` names after them.
 *
 * Four entry points, deliberately:
 *
 * - `index` is the library consumed by the application.
 * - `diagnostics` is the read-only observer behind `serial-broker/diagnostics` (ADR-0018). It
 *   shares no state with `index` by design, so bundling it separately duplicates nothing that
 *   matters.
 * - `global.ts` and `global-diagnostics.ts` are the same two surfaces as classic scripts, for a
 *   page that loads the library with `<script src>` and writes no modules at all (ADR-0043).
 *   They are built as IIFEs that put one global each on the page and export nothing.
 * - `serial-broker.worker` is the broker script. It must be a separately addressable file,
 *   because a `SharedWorker` is identified by its script URL: a bundled-in `Blob` URL would
 *   differ per tab and each tab would get its own, unshared worker. See ADR-0006.
 *
 * The worker is built as an ES module only: it is started with `type: 'module'`, and a CommonJS
 * copy would be a file nothing can load. It is minified like the other published files - it is
 * served to every tab of every installation, and nothing reads it (ADR-0003). Its source map is
 * published beside it, so a fault on a production line is still debuggable.
 *
 * Every build - readable, minified, CommonJS or classic - keeps looking for the same
 * `serial-broker.worker.js`. A worker of their own would be a different `SharedWorker`, and their
 * tabs could not coordinate with tabs on any other build. scripts/check-dist.mjs checks all of
 * them after every build.
 */
export default defineConfig([
  {
    ...common,
    entry: {
      'serial-broker': 'src/index.ts',
      'serial-broker.diagnostics': 'src/diagnostics.ts',
    },
    format: ['esm', 'cjs'],
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
    // tsup runs these configurations at once, so this clean spares the other outputs rather than
    // racing to delete them.
    clean: [
      '!serial-broker.worker.js',
      '!serial-broker.worker.js.map',
      '!*.min.js',
      '!*.min.js.map',
      '!*.global.js',
      '!*.global.js.map',
    ],
    esbuildOptions(options, { format }) {
      if (format === 'cjs') {
        // CommonJS has no `import.meta.url` to find the worker script with. See
        // scripts/import-meta-stand-in.mjs for why the replacement throws instead of guessing.
        options.define = { ...options.define, 'import.meta.url': 'cjsImportMeta.url' };
        // Resolved from the working directory - the repository root, where the npm script runs -
        // not from this file's directory (ADR-0042), as `entry` above is.
        options.inject = [...(options.inject ?? []), 'scripts/import-meta-stand-in.mjs'];
      }
    },
  },
  {
    ...common,
    entry: { 'serial-broker.worker': 'src/worker/serial-broker.worker.ts' },
    format: ['esm'],
    minify: true,
    clean: false,
  },
  {
    ...common,
    entry: {
      'serial-broker': 'src/index.ts',
      'serial-broker.diagnostics': 'src/diagnostics.ts',
    },
    format: ['esm'],
    minify: true,
    outExtension: () => ({ js: '.min.js' }),
    clean: false,
  },
  {
    ...common,
    entry: {
      'serial-broker': 'src/global.ts',
      'serial-broker.diagnostics': 'src/global-diagnostics.ts',
    },
    // An IIFE with no `globalName`: each entry puts its own global on the page itself, so that
    // one page needs exactly one name rather than a module namespace object to reach through.
    format: ['iife'],
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
    clean: false,
    esbuildOptions(options) {
      // A classic script has no `import.meta` either, and the same rule applies: name the fix,
      // never guess a URL.
      options.define = { ...options.define, 'import.meta.url': 'globalImportMeta.url' };
      options.inject = [...(options.inject ?? []), 'scripts/import-meta-stand-in.mjs'];
    },
  },
]);
