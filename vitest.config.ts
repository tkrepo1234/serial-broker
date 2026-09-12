import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Plain Node: no browser globals exist here on purpose. Every platform API this library
    // uses is injected (ADR-0014), so code that reaches for a global fails loudly in tests
    // instead of silently working in production and lying under a DOM emulator.
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
        // The coordination layer carries the risk, so it carries the higher bar.
        'src/master/**': { statements: 95, branches: 95, functions: 95, lines: 95 },
        'src/worker/**': { statements: 95, branches: 95, functions: 95, lines: 95 },
        'src/client/**': { statements: 95, branches: 95, functions: 95, lines: 95 },
      },
    },
  },
});
