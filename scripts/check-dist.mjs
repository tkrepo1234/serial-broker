/**
 * Checks what `npm run build` produced against what the package promises.
 *
 * - Every path the package's `exports` name exists, so no import of the published package can
 *   fail on a missing file.
 * - The minified builds export exactly what the readable ones export, so switching between
 *   `serial-broker` and `serial-broker/min` cannot lose anything.
 * - Both look for the same worker script, `serial-broker.worker.js`. A `SharedWorker` is identified
 *   by its script URL (ADR-0006): a minified build that started a worker of its own would leave its
 *   tabs unable to coordinate with tabs on the readable build.
 * - A minified file is smaller than its readable counterpart.
 *
 * Run by `npm run build`, last. Fails the build with a list of what is wrong.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const problems = [];

for (const target of exportTargets(packageJson.exports)) {
  // A pattern such as `./dist/debug/*` names a directory of files.
  const path = join(root, target.replace(/\/\*$/, ''));
  if (!existsSync(path)) {
    problems.push(`exports names ${target}, which the build did not produce`);
  }
}

const WORKER_SCRIPT = 'serial-broker.worker.js';
const pairs = [
  ['dist/index.js', 'dist/index.min.js'],
  ['dist/diagnostics.js', 'dist/diagnostics.min.js'],
];
const sizes = [];

for (const [readable, minified] of pairs) {
  if (!existsSync(join(root, readable)) || !existsSync(join(root, minified))) {
    problems.push(`${readable} or ${minified} is missing`);
    continue;
  }

  const readableExports = Object.keys(
    await import(pathToFileURL(join(root, readable)).href),
  ).sort();
  const minifiedExports = Object.keys(
    await import(pathToFileURL(join(root, minified)).href),
  ).sort();
  if (JSON.stringify(readableExports) !== JSON.stringify(minifiedExports)) {
    problems.push(
      `${minified} exports ${minifiedExports.join(', ')}, but ${readable} exports ${readableExports.join(', ')}`,
    );
  }

  const readableText = readFileSync(join(root, readable), 'utf8');
  const minifiedText = readFileSync(join(root, minified), 'utf8');
  if (readableText.includes(WORKER_SCRIPT) !== minifiedText.includes(WORKER_SCRIPT)) {
    problems.push(`${readable} and ${minified} do not look for the same worker script`);
  }

  for (const file of [readable, minified]) {
    const bytes = readFileSync(join(root, file));
    sizes.push({ file, bytes: statSync(join(root, file)).size, gzip: gzipSync(bytes).length });
  }
  if (statSync(join(root, minified)).size >= statSync(join(root, readable)).size) {
    problems.push(`${minified} is not smaller than ${readable}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`The build does not match the package:\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
for (const { file, bytes, gzip } of sizes) {
  process.stdout.write(`${file}: ${kb(bytes)}, ${kb(gzip)} gzipped\n`);
}
process.stdout.write('The build matches the package exports.\n');

/** Every file path named anywhere in an `exports` map, conditions included. */
function exportTargets(value) {
  if (typeof value === 'string') {
    return [value];
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  return Object.values(value).flatMap(exportTargets);
}
