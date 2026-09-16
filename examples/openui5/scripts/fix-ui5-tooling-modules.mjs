/**
 * Corrects one line in ui5-tooling-modules before the UI5 server or build reads it.
 *
 * Its import-meta plugin looks at every `new URL(..., import.meta.url)` in a bundled dependency -
 * serial-broker has one, for the worker script - and means to strip a query string from the
 * resolved path. It asks `if (resolvedModuleId.indexOf("?"))`, which is truthy at `-1`, so a path
 * without a query is cut to the empty string and the plugin then reads the file `''`. The bundle
 * fails and the application never loads.
 *
 * The line is corrected in place, in this example's own `node_modules`, every time the example
 * starts or builds (as `prestart` / `prebuild`). Nothing outside this directory is touched, the
 * correction is what the plugin's own comment says it wants, and once the package ships the fix
 * this script finds nothing to do and says so. See ADR-0044.
 */

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BROKEN = 'if (resolvedModuleId.indexOf("?")) {';
const CORRECTED = 'if (resolvedModuleId.indexOf("?") !== -1) {';

const require = createRequire(import.meta.url);

let file;
try {
  file = join(
    dirname(require.resolve('ui5-tooling-modules/package.json')),
    'lib',
    'rollup-plugin-import-meta.js',
  );
} catch {
  process.stderr.write(
    'ui5-tooling-modules is not installed. Run `npm install` in this example first.\n',
  );
  process.exit(1);
}

const text = readFileSync(file, 'utf8');
if (text.includes(BROKEN)) {
  writeFileSync(file, text.replace(BROKEN, CORRECTED));
  process.stdout.write(`Corrected the import-meta plugin in ${file}\n`);
} else if (text.includes(CORRECTED)) {
  process.stdout.write('The import-meta plugin is already corrected.\n');
} else {
  // Neither form: the package has been rewritten. Say so rather than fail - it may well be fixed.
  process.stdout.write(
    'ui5-tooling-modules no longer contains the line this script corrects; leaving it alone.\n',
  );
}
