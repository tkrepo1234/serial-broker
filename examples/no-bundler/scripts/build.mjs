/**
 * The "production build": copies what a web server has to serve into `dist/`.
 *
 * There is nothing to compile. What a deployment needs is the page and the library files at the
 * URL the import map and `configure({ workerUrl })` name - `/serial-broker/` - so this script
 * assembles exactly that folder, and any static web server serves it as it is. Serving it under a
 * sub-path (`https://host/scale/`) needs the import map and the worker URL adjusted; see the
 * README.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIBRARY_DIRECTORY = path.join(HERE, 'node_modules', 'serial-broker', 'dist');
const OUTPUT = path.join(HERE, 'dist');

/** The library files the page loads. The source maps are optional, and worth their bytes. */
const LIBRARY_FILES = [
  'serial-broker.min.js',
  'serial-broker.min.js.map',
  'serial-broker.worker.js',
  'serial-broker.worker.js.map',
];

if (!existsSync(path.join(LIBRARY_DIRECTORY, 'serial-broker.min.js'))) {
  process.stderr.write(
    'node_modules/serial-broker/dist/ is missing or incomplete. Run `npm run build` in the ' +
      'repository root, then `npm install` here.\n',
  );
  process.exit(1);
}

rmSync(OUTPUT, { recursive: true, force: true });
cpSync(path.join(HERE, 'public'), OUTPUT, { recursive: true });
mkdirSync(path.join(OUTPUT, 'serial-broker'));
for (const file of LIBRARY_FILES) {
  cpSync(path.join(LIBRARY_DIRECTORY, file), path.join(OUTPUT, 'serial-broker', file));
}

process.stdout.write(`Built ${OUTPUT}: serve it with any static web server.\n`);
