import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { defineConfig } from '@playwright/test';

/**
 * The example applications' smoke tests: each example is started with its own `npm start` on
 * the port its `example.json` names, and its `smoke.spec.ts` drives it in a real browser with the
 * Web Serial stand-in installed. See examples/README.md for the contract, and ADR-0021 for why the
 * browser suites look the way they do.
 *
 * Only examples whose dependencies are installed are started: an example without `node_modules`
 * is skipped, so that a developer who installed one example can test that one alone.
 */

interface ExampleManifest {
  readonly name: string;
  readonly port: number;
  readonly start: string;
  readonly readyPath: string;
}

// This file lives in config/ (ADR-0025); the examples are a directory up.
const examplesDir = join(import.meta.dirname, '..', 'examples');
const only = process.argv.slice(2).filter((argument) => argument.startsWith('examples/'));

const examples = readdirSync(examplesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(examplesDir, entry.name))
  .filter((directory) => existsSync(join(directory, 'example.json')))
  .filter((directory) => existsSync(join(directory, 'node_modules')))
  .filter((directory) => existsSync(join(directory, 'smoke.spec.ts')))
  .filter(
    (directory) =>
      only.length === 0 ||
      only.some((argument) =>
        argument
          .replaceAll('\\', '/')
          .startsWith(`examples/${directory.split(/[\\/]/).pop() ?? ''}`),
      ),
  )
  .map((directory) => ({
    directory,
    manifest: JSON.parse(readFileSync(join(directory, 'example.json'), 'utf8')) as ExampleManifest,
  }));

export default defineConfig({
  // Resolved against config/, so both reach back to the repository root; `outputDir` keeps the
  // traces where CI collects them rather than under config/.
  testDir: '../examples',
  outputDir: '../test-results',
  testMatch: '**/smoke.spec.ts',
  testIgnore: '**/node_modules/**',
  // One at a time: each example runs its own dev server, and the machine runs everything else.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: [['list']],
  timeout: 90_000,
  expect: { timeout: 20_000 },

  use: {
    channel: process.env['SERIAL_BROKER_BROWSER_CHANNEL'] ?? 'msedge',
    trace: 'retain-on-failure',
  },

  webServer: examples.map(({ directory, manifest }) => ({
    command: manifest.start,
    cwd: directory,
    url: `http://localhost:${String(manifest.port)}${manifest.readyPath}`,
    // Never talk to a server someone left behind: it may serve another build.
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  })),
});
