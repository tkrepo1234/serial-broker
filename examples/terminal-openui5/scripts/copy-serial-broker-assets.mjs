/**
 * Copies the serial-broker files the page loads into the application's own resources.
 *
 * Two of them: the library as a classic script (`serial-broker.global.js`), which index.html loads
 * with a plain `<script>` so the built page can run from a folder opened as a file, and the broker
 * script (`serial-broker.worker.js`), which every tab has to load from the same URL. The package's
 * `dist/` is not part of what UI5 Tooling serves, so both are copied next to the page:
 *
 *     node scripts/copy-serial-broker-assets.mjs webapp --with-stand-in   (before `npm start`)
 *     node scripts/copy-serial-broker-assets.mjs webapp --remove          (before a build)
 *     node scripts/copy-serial-broker-assets.mjs dist                     (after a build)
 *
 * `webapp/serial-broker/` is generated, and git-ignored. It is removed before a build because the
 * bundler would otherwise try to pack a worker and a classic script into the application's bundle;
 * the built folder gets its copy afterwards.
 *
 * `--with-stand-in` also writes `stand-in.js`: the repository's Web Serial stand-in as a classic
 * script, so `?stand-in` lets the terminal be tried on a machine with no adapter. A build has
 * none: it has no business on a station.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const [folder = 'webapp', option] = process.argv.slice(2);
const target = join(appRoot, folder, 'serial-broker');

if (option === '--remove') {
  rmSync(target, { recursive: true, force: true });
  process.exit(0);
}

/** What the browser fetches at run time: without either of these the page does not work. */
const FILES = ['serial-broker.global.js', 'serial-broker.worker.js'];

const packageRoot = rootOfTheLibrary();

const distribution = join(packageRoot, 'dist');
const missing = FILES.map((file) => join(distribution, file)).filter((file) => !existsSync(file));
if (missing.length > 0) {
  fail(
    [
      ...missing.map((file) => `${file} does not exist.`),
      'This example uses the library from the repository it lives in, so build it once:',
      '',
      '  cd ../..  &&  npm ci  &&  npm run build',
      '',
    ].join('\n'),
  );
}

mkdirSync(target, { recursive: true });
for (const file of FILES) {
  copyFileSync(join(distribution, file), join(target, file));
  // The source maps are optional, but make debugging sane.
  if (existsSync(join(distribution, `${file}.map`))) {
    copyFileSync(join(distribution, `${file}.map`), join(target, `${file}.map`));
  }
}

// The stand-in lives in the repository's test sources, as a TypeScript module. Stripped of its
// types and of its `export`, it is a classic script that defines one function.
const standIn = join(packageRoot, 'test', 'browser', 'stand-in', 'web-serial-stand-in.ts');
if (option === '--with-stand-in' && existsSync(standIn)) {
  const script = stripTypeScriptTypes(readFileSync(standIn, 'utf8'), { mode: 'strip' }).replace(
    /^export function /gm,
    'function ',
  );
  writeFileSync(
    join(target, 'stand-in.js'),
    `${script}\nglobalThis.installWebSerialStandIn = installWebSerialStandIn;\n`,
  );
}

process.stdout.write(`Copied the serial-broker files to ${target}\n`);

/** @returns {string} */
function rootOfTheLibrary() {
  try {
    return dirname(require.resolve('serial-broker/package.json'));
  } catch {
    return fail(
      'serial-broker is not installed. Run `npm install` in examples/terminal-openui5 first.',
    );
  }
}

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
