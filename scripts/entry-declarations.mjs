/**
 * Names the published entry declarations after the package, as the bundles are named.
 *
 * Every published file is named after the package rather than after the entry file it was built
 * from, so that a file copied onto a web server says what it is (ADR-0043): `serial-broker.js`,
 * `serial-broker.min.js`, `serial-broker.global.js`, `serial-broker.worker.js`. The bundler is
 * told those names directly, through its entry keys. `tsc` cannot be: it names every declaration
 * after its source file, and the source files are `src/index.ts` and `src/diagnostics.ts` - the
 * conventional names for a barrel, which the documentation, TypeDoc's entry points and the
 * guidelines all refer to.
 *
 * So the two entry declarations are renamed here instead. Both are leaves of the declaration
 * graph - nothing under dist/ imports them, because nothing inside the library imports through an
 * entry point - and both stay at the same depth, so the relative imports inside them still
 * resolve. Anything else that referred to them would be a mistake this script must not paper
 * over, which is why a name that is already taken, or a file that is missing, fails the build.
 *
 * Run by `npm run build`, after `tsc` and before `scripts/cjs-types.mjs`, which then copies the
 * declarations to dist/cjs/ under their published names.
 */

import { existsSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Emitted name -> published name. */
const RENAMES = [
  ['index.d.ts', 'serial-broker.d.ts'],
  ['diagnostics.d.ts', 'serial-broker.diagnostics.d.ts'],
];

const problems = [];
for (const [emitted, published] of RENAMES) {
  const from = join(dist, emitted);
  const to = join(dist, published);
  if (!existsSync(from)) {
    problems.push(`tsc did not emit dist/${emitted}`);
    continue;
  }
  if (existsSync(to)) {
    // A source file now emits the published name itself. Renaming over it would delete a
    // declaration the package needs, silently.
    problems.push(`dist/${published} already exists; dist/${emitted} cannot be renamed onto it`);
    continue;
  }
  renameSync(from, to);
}

if (problems.length > 0) {
  process.stderr.write(`The entry declarations could not be named:\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}

process.stdout.write(`Named ${String(RENAMES.length)} entry declarations after the package\n`);
