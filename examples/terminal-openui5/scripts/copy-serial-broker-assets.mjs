/**
 * Copies the serial-broker files the page loads into the application's own resources.
 *
 * Two of them: the library as a classic script (`serial-broker.global.js`), which index.html loads
 * with a plain `<script>` so the built page can run from a folder opened as a file, and the broker
 * script (`serial-broker.worker.js`), which every tab has to load from the same URL. The package's
 * `dist/` is not part of what UI5 Tooling serves, so both are copied into `webapp/serial-broker/`
 * before the server starts or the build runs. That folder is therefore generated, and git-ignored.
 *
 * In development it also writes `stand-in.js`: the repository's Web Serial stand-in as a classic
 * script, so `?stand-in` lets the terminal be tried on a machine with no adapter. A build removes
 * it again (scripts/finish-build.mjs): it has no business on a station.
 *
 * Run automatically by `npm start` and `npm run build` (as `prestart` / `prebuild`).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(appRoot, 'webapp', 'serial-broker');

/** What the browser fetches at run time. The source maps are optional but make debugging sane. */
const FILES = [
  'serial-broker.global.js',
  'serial-broker.global.js.map',
  'serial-broker.worker.js',
  'serial-broker.worker.js.map',
];

let packageRoot;
try {
  packageRoot = dirname(require.resolve('serial-broker/package.json'));
} catch {
  fail('serial-broker is not installed. Run `npm install` in examples/terminal-openui5 first.');
}

const distribution = join(packageRoot, 'dist');
if (!existsSync(join(distribution, 'serial-broker.global.js'))) {
  fail(
    [
      `${join(distribution, 'serial-broker.global.js')} does not exist.`,
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

// The stand-in lives in the repository's test sources, as a TypeScript module. Stripped of its
// types and of its `export`, it is a classic script that defines one function.
const standIn = join(packageRoot, 'test', 'browser', 'stand-in', 'web-serial-stand-in.ts');
if (existsSync(standIn)) {
  const script = stripTypeScriptTypes(readFileSync(standIn, 'utf8'), { mode: 'strip' }).replace(
    /^export (async )?function /gm,
    '$1function ',
  );
  writeFileSync(
    join(target, 'stand-in.js'),
    `${script}\nglobalThis.installWebSerialStandIn = installWebSerialStandIn;\n`,
  );
}

process.stdout.write(`Copied the serial-broker files to ${target}\n`);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
