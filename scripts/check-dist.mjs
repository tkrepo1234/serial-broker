/**
 * Checks what `npm run build` produced against what the package promises.
 *
 * - Every path the package's `exports` name exists, so no import of the published package can
 *   fail on a missing file.
 * - The minified builds export exactly what the readable ones export, so switching between
 *   `serial-broker` and `serial-broker/min` cannot lose anything.
 * - The classic script builds put the same surface on one global each, so a page that loads
 *   `<script src="serial-broker.global.js">` can reach everything a module can (ADR-0043). The
 *   file is run here, in a context with no browser in it, and the global it leaves behind is
 *   compared with the ES module's exports - so the two cannot drift.
 * - Every build looks for the same worker script, `serial-broker.worker.js`. A `SharedWorker` is
 *   identified by its script URL (ADR-0006): a build that started a worker of its own would leave
 *   its tabs unable to coordinate with tabs on any other build.
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
import { createContext, runInContext } from 'node:vm';

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

/**
 * The three builds of each entry point, and what the classic one leaves on a page.
 *
 * `isTheGlobal` names the one export the global *is* rather than carries: the main entry point's
 * global is the facade itself, so `SerialBroker.setup()` reads the same as in a module and a page
 * needs exactly one name (ADR-0043). The diagnostics global carries all three of its exports.
 */
const ENTRY_POINTS = [
  {
    readable: 'dist/serial-broker.js',
    minified: 'dist/serial-broker.min.js',
    classic: 'dist/serial-broker.global.js',
    global: 'SerialBroker',
    isTheGlobal: 'SerialBroker',
  },
  {
    readable: 'dist/serial-broker.diagnostics.js',
    minified: 'dist/serial-broker.diagnostics.min.js',
    classic: 'dist/serial-broker.diagnostics.global.js',
    global: 'SerialBrokerDiagnostics',
    isTheGlobal: undefined,
  },
];

for (const entry of ENTRY_POINTS) {
  const files = [entry.readable, entry.minified, entry.classic];
  const missingFiles = files.filter((file) => !existsSync(join(root, file)));
  if (missingFiles.length > 0) {
    problems.push(`the build did not produce ${missingFiles.join(', ')}`);
    continue;
  }

  const namespace = await import(pathToFileURL(join(root, entry.readable)).href);
  const readableExports = Object.keys(namespace).sort();
  const minifiedExports = Object.keys(
    await import(pathToFileURL(join(root, entry.minified)).href),
  ).sort();
  if (JSON.stringify(readableExports) !== JSON.stringify(minifiedExports)) {
    problems.push(
      `${entry.minified} exports ${minifiedExports.join(', ')}, but ${entry.readable} exports ${readableExports.join(', ')}`,
    );
  }

  // Not "the same as each other" but "this one, by name": a rename in the source that reached
  // every build at once would still leave the deployed file under the name every tab must share.
  for (const file of files) {
    if (!readFileSync(join(root, file), 'utf8').includes(WORKER_SCRIPT)) {
      problems.push(`${file} does not look for ${WORKER_SCRIPT}`);
    }
  }

  if (statSync(join(root, entry.minified)).size >= statSync(join(root, entry.readable)).size) {
    problems.push(`${entry.minified} is not smaller than ${entry.readable}`);
  }

  problems.push(...classicSurfaceProblems(entry, namespace));
}

// Loading the package where there is no browser, as server-side rendering does, must not throw, and
// must report the library as unsupported rather than fail later.
const require = createRequire(import.meta.url);
for (const file of [
  'dist/serial-broker.js',
  'dist/serial-broker.min.js',
  'dist/serial-broker.cjs',
  'dist/serial-broker.diagnostics.js',
  'dist/serial-broker.diagnostics.min.js',
  'dist/serial-broker.diagnostics.cjs',
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
 * Runs a classic script build the way a page does, and checks what it leaves behind.
 *
 * The file is an IIFE, so it can be run in a context of its own - a plain object as the global -
 * and the globals it defines are then that object's own properties. There is no browser in that
 * context, which is the second thing checked: a page that loads this file where Web Serial does
 * not exist must be told so by `isSupported()`, not by an exception while the script loads.
 *
 * @param {{ readable: string, classic: string, global: string, isTheGlobal: string | undefined }}
 *   entry - One row of `ENTRY_POINTS`.
 * @param {Record<string, unknown>} namespace - What the ES module build of the same entry
 *   point exports, which is the surface the global has to match.
 * @returns One problem per difference.
 */
function classicSurfaceProblems(entry, namespace) {
  const found = [];
  const context = createContext({});
  try {
    runInContext(readFileSync(join(root, entry.classic), 'utf8'), context, {
      filename: entry.classic,
    });
  } catch (error) {
    return [`${entry.classic} throws when loaded outside a browser: ${String(error)}`];
  }

  const exposed = context[entry.global];
  if (exposed === undefined || exposed === null) {
    return [`${entry.classic} leaves no ${entry.global} behind on the page`];
  }
  const others = Object.keys(context).filter((name) => name !== entry.global);
  if (others.length > 0) {
    // One name per build, so that a page can say what it took from this library.
    found.push(`${entry.classic} also defines the globals ${others.join(', ')}`);
  }

  for (const name of Object.keys(namespace).sort()) {
    if (name === entry.isTheGlobal) {
      // This export *is* the global, so every member of it must be reachable on the global.
      for (const member of Object.keys(namespace[name]).sort()) {
        if (!(member in exposed)) {
          found.push(`${entry.global} is missing ${name}.${member}()`);
        }
      }
      continue;
    }
    if (!(name in exposed)) {
      found.push(`${entry.global} is missing ${name}, which ${entry.readable} exports`);
    }
  }

  if (typeof exposed.isSupported === 'function' && exposed.isSupported() !== false) {
    found.push(`${entry.classic} reports itself supported outside a browser`);
  }
  return found;
}

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
