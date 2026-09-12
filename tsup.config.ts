import { defineConfig } from 'tsup';

/**
 * Two entry points, deliberately:
 *
 * - `index` is the library consumed by the application.
 * - `serial-broker.worker` is the broker script. It must be a separately addressable file,
 *   because a `SharedWorker` is identified by its script URL: a bundled-in `Blob` URL would
 *   differ per tab and each tab would get its own, unshared worker. See ADR-0006.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'serial-broker.worker': 'src/worker/serial-broker.worker.ts',
  },
  format: ['esm', 'cjs'],
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
  target: 'es2022',
  platform: 'browser',
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
});
