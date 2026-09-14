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
 * - The size of every build is printed, as built and gzipped, so that CI reports it on every run.
 *   There is no size budget: the sizes are reported, not enforced (BACKLOG.md, decided
 *   2026-09-14).
 * - Every declaration the build emitted - not only the ones an entry point names - type-checks
 *   without the Web Serial types, which the package cannot make an application install.
 *
 * Run by `npm run build`, last. Fails the build with a list of what is wrong.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { distSizes, kilobytes } from './dist-sizes.mjs';

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

  if (statSync(join(root, minified)).size >= statSync(join(root, readable)).size) {
    problems.push(`${minified} is not smaller than ${readable}`);
  }
}

// Loading the package where there is no browser, as server-side rendering does, must not throw, and
// must report the library as unsupported rather than fail later.
const require = createRequire(import.meta.url);
for (const file of [
  'dist/index.js',
  'dist/index.min.js',
  'dist/index.cjs',
  'dist/diagnostics.js',
  'dist/diagnostics.min.js',
  'dist/diagnostics.cjs',
]) {
  try {
    const path = join(root, file);
    const module = file.endsWith('.cjs') ? require(path) : await import(pathToFileURL(path).href);
    if ('isSupported' in module && module.isSupported() !== false) {
      problems.push(`${file} reports itself supported outside a browser`);
    }
  } catch (error) {
    problems.push(`${file} throws when loaded outside a browser: ${String(error)}`);
  }
}

problems.push(...(await checkDeclarations()));

if (problems.length > 0) {
  process.stderr.write(`The build does not match the package:\n- ${problems.join('\n- ')}\n`);
  process.exit(1);
}

for (const { file, bytes, gzip } of distSizes(root)) {
  process.stdout.write(`${file}: ${kilobytes(bytes)}, ${kilobytes(gzip)} gzipped\n`);
}
process.stdout.write('The build matches the package exports.\n');

/**
 * Type-checks every published declaration the way a strict application does.
 *
 * `skipLibCheck: false`, no `@types` packages and only the `ES2022` and `DOM` libraries: an
 * application that has not installed `@types/w3c-web-serial` must be able to type-check against
 * the package. A declaration that names `SerialPort` or another Web Serial type fails here, where
 * the repository's own configuration, which loads those types, would not notice it.
 *
 * Every `.d.ts` under dist/ is checked, not only the ones the entry points reach: a file that no
 * export names today is one an import of a deep path reaches tomorrow, and `skipLibCheck: false`
 * in an application checks the lot. dist/debug/ is excluded - it is a page, not a module (ADR-0019).
 *
 * @returns One problem per diagnostic.
 */
async function checkDeclarations() {
  const { default: ts } = await import('typescript');
  const entries = declarationFiles(join(root, 'dist'));
  if (entries.length === 0) {
    return ['the build produced no declaration files'];
  }
  const program = ts.createProgram(entries, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
    types: [],
    strict: true,
    skipLibCheck: false,
    noEmit: true,
  });
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      return `declarations: ${text}`;
    }
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    const file = diagnostic.file.fileName.slice(root.length + 1);
    return `declarations: ${file}:${String(line + 1)}: ${text}`;
  });
}

/** Every `.d.ts` under `directory`, recursively, except the debugging surface's. */
function declarationFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'debug') {
        found.push(...declarationFiles(path));
      }
    } else if (entry.name.endsWith('.d.ts')) {
      found.push(path);
    }
  }
  return found;
}

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
