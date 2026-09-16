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
 * Three entry points, deliberately:
 *
 * - `index` is the library consumed by the application.
 * - `diagnostics` is the read-only observer behind `serial-broker/diagnostics` (ADR-0018). It
 *   shares no state with `index` by design, so bundling it separately duplicates nothing that
 *   matters.
 * - `serial-broker.worker` is the broker script. It must be a separately addressable file,
 *   because a `SharedWorker` is identified by its script URL: a bundled-in `Blob` URL would
 *   differ per tab and each tab would get its own, unshared worker. See ADR-0006.
 *
 * The worker is built as an ES module only: it is started with `type: 'module'`, and a CommonJS
 * copy would be a file nothing can load.
 *
 * `index` and `diagnostics` are built once more, minified, as `*.min.js` ES modules for pages that
 * load the library without a bundler. They keep looking for the same `serial-broker.worker.js`:
 * a worker of their own would be a different `SharedWorker`, and their tabs could not coordinate
 * with tabs on the readable build. scripts/check-dist.mjs checks both after every build.
 */
export default defineConfig([
  {
    ...common,
    entry: {
      index: 'src/index.ts',
      diagnostics: 'src/diagnostics.ts',
    },
    format: ['esm', 'cjs'],
    outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
    // tsup runs both configurations at once, so this clean spares the worker's output rather
    // than racing to delete it.
    clean: [
      '!serial-broker.worker.js',
      '!serial-broker.worker.js.map',
      '!*.min.js',
      '!*.min.js.map',
    ],
    esbuildOptions(options, { format }) {
      if (format === 'cjs') {
        // CommonJS has no `import.meta.url` to find the worker script with. See
        // scripts/cjs-import-meta.mjs for why the replacement throws instead of guessing.
        options.define = { ...options.define, 'import.meta.url': 'cjsImportMeta.url' };
        // Resolved from the working directory - the repository root, where the npm script runs -
        // not from this file's directory (ADR-0042), as `entry` above is.
        options.inject = [...(options.inject ?? []), 'scripts/cjs-import-meta.mjs'];
      }
    },
  },
  {
    ...common,
    entry: { 'serial-broker.worker': 'src/worker/serial-broker.worker.ts' },
    format: ['esm'],
    clean: false,
  },
  {
    ...common,
    entry: {
      index: 'src/index.ts',
      diagnostics: 'src/diagnostics.ts',
    },
    format: ['esm'],
    minify: true,
    outExtension: () => ({ js: '.min.js' }),
    clean: false,
  },
]);
