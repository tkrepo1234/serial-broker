/**
 * Prints the `script-src` hash of a page's inline import map.
 *
 * A content security policy that allows no inline script still has to allow the import map, and
 * browsers load no import map from a `src` attribute. The hash covers the exact text between
 * `<script type="importmap">` and `</script>` - spaces and line breaks included - so this reads
 * the page as the server delivers it, after any formatter has run. See the documentation, under
 * "Deploying to a web server".
 *
 *     node scripts/importmap-hash.mjs path/to/index.html
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const [page] = process.argv.slice(2);
if (page === undefined) {
  process.stderr.write(
    'Usage: node scripts/importmap-hash.mjs <page.html>' + String.fromCharCode(10),
  );
  process.exit(2);
}

const html = readFileSync(page, 'utf8');
const map = /<script\s+type="importmap"\s*>([\s\S]*?)<\/script>/.exec(html);
if (map === null) {
  process.stderr.write(`${page} has no <script type="importmap"> block.\n`);
  process.exit(1);
}

const hash = createHash('sha256')
  .update(map[1] ?? '', 'utf8')
  .digest('base64');
process.stdout.write(`'sha256-${hash}'\n`);
