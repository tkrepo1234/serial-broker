/**
 * Assembles `dist/`: the page, and the library files it loads, ready for any static web server.
 *
 * There is no bundler and nothing to compile - the page runs as it is written. What this does is
 * put the four files the browser asks for next to each other, so a deployment is a copy of one
 * folder. The stand-in is not copied: `?stand-in` is for trying the terminal without hardware,
 * and has no business on a station.
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'dist');
const LIBRARY = path.join(ROOT, 'node_modules', 'serial-broker', 'dist');

/** What the page loads at run time, by the name the import map and `configure()` use. */
const FILES = [
  'serial-broker.min.js',
  'serial-broker.min.js.map',
  'serial-broker.worker.js',
  'serial-broker.worker.js.map',
];

try {
  await stat(path.join(LIBRARY, 'serial-broker.min.js'));
} catch {
  process.stderr.write(
    'node_modules/serial-broker/dist/ is missing or incomplete. Run `npm run build` in the ' +
      'repository root, then `npm install` here.\n',
  );
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, 'serial-broker'), { recursive: true });
await cp(path.join(ROOT, 'public'), OUT, { recursive: true });

for (const file of FILES) {
  await cp(path.join(LIBRARY, file), path.join(OUT, 'serial-broker', file));
}

process.stdout.write(`Built ${path.relative(process.cwd(), OUT)}\n`);
process.stdout.write('Copy that folder to a web server; it needs no Node at run time.\n');
