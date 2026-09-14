/**
 * Starts the harness benchmark: `npm run bench`.
 *
 * The scenarios are TypeScript that imports the test harness, whose modules import each other by
 * their `.js` names - which Node's own type stripping does not resolve to `.ts` files. So the
 * benchmark is bundled first, with the esbuild the build already uses, into `bench/.build/`
 * (git-ignored), and that bundle is run in a Node of its own with `--expose-gc`, which the
 * steady-state scenario needs to read the heap after a collection. Plain JavaScript, like the
 * other tool scripts in this repository, so that it needs no build step of its own.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'bench', '.build', 'harness.mjs');

mkdirSync(dirname(outfile), { recursive: true });
await build({
  entryPoints: [join(root, 'bench', 'harness', 'main.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  sourcemap: 'inline',
  logLevel: 'warning',
});

const result = spawnSync(process.execPath, ['--expose-gc', outfile, root], {
  cwd: root,
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
