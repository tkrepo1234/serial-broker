import { defineConfig } from 'tsup';

/**
 * The debugging surface, bundled into `dist/debug/` so it ships with the package as static
 * content (ADR-0019).
 *
 * It is an application page rather than part of the library: it inlines the library from source,
 * reaches past the public facade to show internals the facade hides, and is never imported by
 * anyone. `publicDir` copies its HTML and its stylesheet next to the bundle.
 */
export default defineConfig({
  entry: { 'serial-broker-debug': 'debug/src/main.ts' },
  outDir: 'dist/debug',
  publicDir: 'debug/public',
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  splitting: false,
});
