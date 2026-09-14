import process from 'node:process';

import { defineConfig } from '@playwright/test';

/**
 * The browser benchmark: the harness scenarios of `bench/harness/` once more, in a real Chromium
 * with the Web Serial stand-in, so that the platform's own cost - a real `SharedWorker` hop, real
 * `postMessage` cloning, a real renderer crash - is in the numbers. See ADR-0036.
 *
 * Opt-in only: `SERIAL_BROKER_BENCH_BROWSER=1 npm run bench:browser`. It never runs in CI, where a
 * shared runner's timings would say nothing; its numbers are recorded once, with the machine, in
 * the Performance chapter. One browser at a time, on a port of its own, so that it can run next
 * to the browser suite.
 */

const port = Number(process.env['SERIAL_BROKER_BROWSER_TEST_PORT'] ?? '8147');
const baseURL = `http://localhost:${String(port)}`;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  // Each transport's run is one test, and the write scenarios are paced in real time.
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },

  use: {
    baseURL,
    channel: process.env['SERIAL_BROKER_BROWSER_CHANNEL'] ?? 'msedge',
  },

  webServer: {
    command: `"${process.execPath}" test/browser/server.mjs`,
    cwd: '../..',
    url: `${baseURL}/bench/bench.html`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { SERIAL_BROKER_BROWSER_TEST_PORT: String(port) },
  },
});
