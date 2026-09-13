/**
 * Gives CommonJS consumers type declarations that describe CommonJS.
 *
 * The package is `"type": "module"`, so every `.d.ts` under dist/ declares an ES module. With
 * TypeScript's `node16`, `nodenext` or `bundler` resolution, a `require` of the package would get
 * those ES-module declarations for a CommonJS file and report its types as masquerading. A copy
 * of the declarations under dist/cjs/, next to a package.json that says `"type": "commonjs"`,
 * describes what `require` actually loads. The package's `exports` point `require` there.
 *
 * Run by `npm run build`, after `tsc` has emitted the declarations.
 */

import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const target = join(dist, 'cjs');

rmSync(target, { recursive: true, force: true });

let copied = 0;
copyDeclarations(dist);
writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

process.stdout.write(`Copied ${String(copied)} declaration files to dist/cjs\n`);

function copyDeclarations(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // The debugging surface is a page, not a module, and dist/cjs is this script's own output.
      if (path !== target && entry.name !== 'debug') {
        copyDeclarations(path);
      }
    } else if (entry.name.endsWith('.d.ts')) {
      // Declaration maps are left out: their source paths are relative to where tsc wrote them.
      const destination = join(target, relative(dist, path));
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(path, destination);
      copied += 1;
    }
  }
}
