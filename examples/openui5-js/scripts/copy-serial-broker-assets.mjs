/**
 * Copies the serial-broker broker script into the application's own resources.
 *
 * A `SharedWorker` is identified by the URL of its script, and that URL has to be one the page's
 * origin serves - the tabs of this application must all reach the same file. The package's
 * `dist/` is not part of what UI5 Tooling serves, so the script is copied into
 * `webapp/serial-broker/` before the server starts, from where UI5 Tooling serves it like any
 * other application resource. `webapp/serial-broker/` is therefore generated, and git-ignored.
 *
 * Run automatically by `npm start` and `npm run build` (as `prestart` / `prebuild`).
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(appRoot, 'webapp', 'serial-broker');

/** The files the browser fetches at run time. The source map is optional but makes debugging sane. */
const FILES = ['serial-broker.worker.js', 'serial-broker.worker.js.map'];

let packageRoot;
try {
  packageRoot = dirname(require.resolve('serial-broker/package.json'));
} catch {
  fail('serial-broker is not installed. Run `npm install` in examples/openui5-js first.');
}

const distribution = join(packageRoot, 'dist');
if (!existsSync(join(distribution, 'serial-broker.worker.js'))) {
  fail(
    [
      `${join(distribution, 'serial-broker.worker.js')} does not exist.`,
      'This example uses the library from the repository it lives in, so build it once:',
      '',
      '  cd ../..  &&  npm ci  &&  npm run build',
      '',
    ].join('\n'),
  );
}

mkdirSync(target, { recursive: true });
for (const file of FILES) {
  const from = join(distribution, file);
  if (existsSync(from)) {
    copyFileSync(from, join(target, file));
  }
}

process.stdout.write(`Copied the serial-broker worker to ${target}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
