/**
 * Serves the built package and the test pages for the browser suite.
 *
 * Started by `config/playwright.config.ts` (`webServer`) and by nothing else. It serves three
 * things:
 *
 * - `/dist/...` - the built package, exactly the files the published one contains. The tests load
 *   the library the way an application does, `new URL('./serial-broker.worker.js', import.meta.url)`
 *   included, so a build that forgets a file fails here rather than in someone's project.
 * - `/*.html`, `/harness.js` - the test pages. `harness.ts` is TypeScript, stripped on the way out
 *   by Node, so the page code is type-checked with the rest of the suite (ADR-0035).
 * - `/other-protocol-version/serial-broker.worker.js` - the worker bundled from source with its
 *   `PROTOCOL_VERSION` changed, which is how a tab meets a worker of another version without a
 *   second checkout (ADR-0008).
 * - `/bench/*` - the browser benchmark's pages (`bench/browser/pages/`), served the same way: a
 *   `.js` that is TypeScript on disk is stripped on the way out (ADR-0037).
 *
 * Plain JavaScript, like the other tool scripts in this repository, so that it needs no build step
 * of its own.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, '..', '..');
const DIST = path.join(REPOSITORY, 'dist');
const PAGES = path.join(HERE, 'pages');
const BENCH_PAGES = path.join(REPOSITORY, 'bench', 'browser', 'pages');

/** The protocol version the transformed worker script reports. Any version but this build's. */
const OTHER_PROTOCOL_VERSION = 9_999;

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.cjs', 'text/javascript; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.ts', 'text/plain; charset=utf-8'],
]);

const port = Number(process.env['SERIAL_BROKER_BROWSER_TEST_PORT'] ?? '8146');

/** Resolves a URL path to a file, and refuses anything outside the directory it belongs to. */
function resolveWithin(root, relative) {
  const resolved = path.resolve(root, `.${relative}`);
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : undefined;
}

/** Built once, then served to every tab that asks for it. */
let workerOfAnotherVersion;

/**
 * The worker script, bundled from source with a different `PROTOCOL_VERSION`.
 *
 * Bundled rather than patched: the published worker is minified (ADR-0003), so its
 * `PROTOCOL_VERSION` is a renamed variable whose value esbuild has folded into the two places
 * that read it - there is no assignment left in the file to replace, and replacing the number
 * would depend on what the minifier happened to emit. The version is changed in
 * `src/protocol/version.ts` as it is loaded instead, which no minifier can rename, and the worker
 * is bundled from there with the settings config/tsup.config.ts uses.
 */
async function readWorkerOfAnotherVersion() {
  workerOfAnotherVersion ??= buildWorkerOfAnotherVersion();
  return await workerOfAnotherVersion;
}

async function buildWorkerOfAnotherVersion() {
  const result = await build({
    entryPoints: [path.join(REPOSITORY, 'src', 'worker', 'serial-broker.worker.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    plugins: [
      {
        name: 'other-protocol-version',
        setup(builder) {
          builder.onLoad({ filter: /[\\/]protocol[\\/]version\.ts$/ }, async (args) => {
            const source = await readFile(args.path, 'utf8');
            const replaced = source.replace(
              /export const PROTOCOL_VERSION = \d+;/,
              `export const PROTOCOL_VERSION = ${OTHER_PROTOCOL_VERSION};`,
            );
            if (replaced === source) {
              // Loud rather than silent: a worker that still runs this version would make the
              // mismatch test pass for the wrong reason.
              throw new Error(
                'src/protocol/version.ts has no PROTOCOL_VERSION declaration to change',
              );
            }
            return { contents: replaced, loader: 'ts' };
          });
        },
      },
    ],
  });
  const [output] = result.outputFiles;
  if (output === undefined) {
    throw new Error('esbuild produced no worker of another protocol version');
  }
  return output.text;
}

/** Answers one request, or `undefined` if nothing matches. */
async function route(pathname) {
  if (pathname === '/') {
    return { status: 302, headers: { location: '/tab.html' }, body: '' };
  }

  if (pathname === '/other-protocol-version/serial-broker.worker.js') {
    return {
      status: 200,
      type: CONTENT_TYPES.get('.js'),
      body: await readWorkerOfAnotherVersion(),
    };
  }

  if (pathname === '/harness.js') {
    const source = await readFile(path.join(PAGES, 'harness.ts'), 'utf8');
    return {
      status: 200,
      type: CONTENT_TYPES.get('.js'),
      body: stripTypeScriptTypes(source, { mode: 'strip' }),
    };
  }

  if (pathname.startsWith('/dist/')) {
    const file = resolveWithin(DIST, pathname.slice('/dist'.length));
    return file === undefined ? undefined : await readStatic(file);
  }

  if (pathname.startsWith('/bench/')) {
    const file = resolveWithin(BENCH_PAGES, pathname.slice('/bench'.length));
    if (file === undefined) {
      return undefined;
    }
    if (file.endsWith('.js')) {
      const stripped = await readStripped(`${file.slice(0, -'.js'.length)}.ts`);
      if (stripped !== undefined) {
        return stripped;
      }
    }
    return await readStatic(file);
  }

  const page = resolveWithin(PAGES, pathname);
  return page === undefined ? undefined : await readStatic(page);
}

/** A TypeScript page module, served as JavaScript; `undefined` if there is no such file. */
async function readStripped(file) {
  try {
    const source = await readFile(file, 'utf8');
    return {
      status: 200,
      type: CONTENT_TYPES.get('.js'),
      body: stripTypeScriptTypes(source, { mode: 'strip' }),
    };
  } catch {
    return undefined;
  }
}

async function readStatic(file) {
  try {
    const body = await readFile(file);
    return { status: 200, type: CONTENT_TYPES.get(path.extname(file)), body };
  } catch {
    return undefined;
  }
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', `http://localhost:${String(port)}`).pathname;

  route(pathname)
    .then((answer) => {
      if (answer === undefined) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(`Not found: ${pathname}\n`);
        return;
      }
      response.writeHead(answer.status, {
        'content-type': answer.type ?? 'application/octet-stream',
        // Every test run must see the build it just made, and a page reloaded mid-test must get
        // the same files rather than a cached mixture.
        'cache-control': 'no-store',
        ...answer.headers,
      });
      response.end(answer.body);
    })
    .catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`${String(error)}\n`);
    });
});

try {
  await readFile(path.join(DIST, 'serial-broker.js'));
} catch {
  process.stderr.write(
    'dist/ is missing or incomplete. Run `npm run build` before the browser tests.\n',
  );
  process.exit(1);
}

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Serving the browser tests on http://localhost:${String(port)}/\n`);
});
