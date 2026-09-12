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
        // The coordination layer carries the risk, so it carries a higher bar for the measures
        // that track whether its code ran at all.
        //
        // Its *branch* bar is lower than the global one, which looks backwards and is not.
        // These modules are dense with guards against races that cannot be produced on demand:
        // "the configuration was released while this message was in flight", "ownership moved
        // between the send and the delivery". They are correct, they are cheap, and they must
        // stay - but staging one from a test would mean reaching into private state, which
        // asserts an implementation instead of a contract (docs/guidelines/testing.md).
        //
        // Coverage is a floor, not a goal.
        'src/owner/**': { statements: 88, branches: 70, functions: 82, lines: 88 },
        'src/worker/**': { statements: 95, branches: 85, functions: 95, lines: 95 },
        'src/client/**': { statements: 94, branches: 80, functions: 95, lines: 94 },
      },
    },
  },
});
