import process from 'node:process';

import { defineConfig } from '@playwright/test';

/**
 * The browser suite: the built package in a real Chromium, with a real `SharedWorker`, real
 * `BroadcastChannel` and real Web Locks.
 *
 * It answers what the in-process suite cannot: that the platform behaves as `test/harness/`
 * claims, and that the files in `dist/` load and find each other. It is deliberately small - the
 * races live in `test/integration/multi-tab/`, where they are deterministic. See ADR-0035 and
 * docs/guidelines/testing.md.
 *
 * Locally it drives the Microsoft Edge that is installed anyway (`channel: 'msedge'`), so
 * nothing is downloaded; CI sets `SERIAL_BROKER_BROWSER_CHANNEL=chromium` and installs that
 * browser explicitly.
 */

/** Chosen from a range nothing else on a development machine uses; override to move it. */
const port = Number(process.env['SERIAL_BROKER_BROWSER_TEST_PORT'] ?? '8146');

const baseURL = `http://localhost:${String(port)}`;

export default defineConfig({
  // Playwright resolves these against the directory this file is in, which is config/ (ADR-0042),
  // so both reach back to the repository root. `outputDir` keeps the traces where CI collects
  // them and where .gitignore expects them, rather than under config/.
  testDir: '../test/browser',
  outputDir: '../test-results',
  testMatch: '**/*.spec.ts',
  // Two at most: other agents and other suites share this machine, and a browser is not cheap.
  workers: 2,
  // Every test gets its own browser context - its own storage partition, its own `SharedWorker`
  // and its own locks - so nothing is shared between tests and none of them may rely on what
  // another left behind. `fullyParallel: false` is not about isolation, then: it is a second cap
  // on how many browsers run at once on a machine that is also running everything else.
  fullyParallel: false,
  forbidOnly: process.env['CI'] !== undefined,
  // A flaky test is a failing test (docs/guidelines/testing.md). Nothing is retried.
  retries: 0,
  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL,
    channel: process.env['SERIAL_BROKER_BROWSER_CHANNEL'] ?? 'msedge',
    trace: 'retain-on-failure',
  },

  webServer: {
    // The same Node that runs the tests, whatever is on PATH. `cwd` is relative to this file, so
    // the server is started from the repository root.
    command: `"${process.execPath}" test/browser/server.mjs`,
    cwd: '..',
    url: `${baseURL}/tab.html`,
    // Never talk to a server someone else left behind: it may serve another build.
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'ignore',
    stderr: 'pipe',
    env: { SERIAL_BROKER_BROWSER_TEST_PORT: String(port) },
  },
});
