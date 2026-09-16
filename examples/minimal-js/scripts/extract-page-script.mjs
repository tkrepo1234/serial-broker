/**
 * Writes the page's inline module script to `.typecheck/`, so that `tsc` can check it.
 *
 * The example is deliberately one file, and TypeScript reads files rather than HTML. This script
 * copies what is between the `<script type="module">` tags of `index.html` into a `.js` file,
 * keeping the line numbers: the copy starts with as many blank lines as the script has HTML above
 * it, so an error `tsc` reports at line 137 is at line 137 of `index.html`.
 *
 * Run by `npm run typecheck`, before `tsc`. The output is generated and git-ignored.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = path.join(HERE, 'index.html');
const OUTPUT = path.join(HERE, '.typecheck', 'index.html.js');

/** The inline module script, and nothing else: the import map is JSON, not JavaScript. */
const INLINE_MODULE = /<script type="module">\n([\s\S]*?)<\/script>/u;

const html = readFileSync(PAGE, 'utf8');
const match = INLINE_MODULE.exec(html);
if (match?.[1] === undefined) {
  process.stderr.write(`${PAGE} has no <script type="module"> block to check.\n`);
  process.exit(1);
}

// Everything before the script's first line, counted in newlines, becomes blank lines, so that
// what tsc reports lines up with the page a reader has open.
const linesAbove = html.slice(0, match.index + match[0].indexOf('\n') + 1).split('\n').length - 1;

mkdirSync(path.dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${'\n'.repeat(linesAbove)}${match[1]}`, 'utf8');
