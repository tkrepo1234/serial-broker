import { defineConfig } from 'tsup';

/**
 * The demo, bundled so it runs from a plain static server with no bundler in the loop.
 *
 * Separate from the library build because it answers to different rules: it is an
 * application, it inlines what it imports, and it is never published.
 */
export default defineConfig({
  entry: { main: 'examples/demo/main.ts' },
  outDir: 'examples/demo',
  format: ['esm'],
  target: 'es2022',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  splitting: false,
});
