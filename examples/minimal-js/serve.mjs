/**
 * The development server: `index.html` at `/`, and the library files at `/serial-broker/`.
 *
 * A page without a bundler needs two files from `node_modules` on its own origin: the library the
 * import map points at, and the worker script, which a `SharedWorker` can only be created from
 * when every tab loads it under the same URL. This server maps `/serial-broker/` to
 * `node_modules/serial-broker/dist/`, so both are there without anything being copied.
 *
 * Plain Node, no dependencies: one fewer package to audit, and short enough to read. The
 * no-bundler example's `serve.mjs` is the same server with a `public/` folder and a build step;
 * here there is one file to serve, and the page is the example.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The same port as example.json names; `PORT` overrides it. */
const PORT = Number(process.env['PORT'] ?? '8159');

/** The published library files, as `npm install` put them there. */
const LIBRARY_DIRECTORY = path.join(HERE, 'node_modules', 'serial-broker', 'dist');

/** Where a URL prefix is served from. The first matching prefix wins, so the longer one is first. */
const MOUNTS = [
  { prefix: '/serial-broker/', directory: LIBRARY_DIRECTORY },
  { prefix: '/', directory: HERE },
];

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

/**
 * The file a request maps to, or `undefined` when nothing serves that path. A path that would
 * leave its directory is refused rather than resolved.
 *
 * @param {string} pathname
 */
function fileFor(pathname) {
  const mount = MOUNTS.find(({ prefix }) => pathname.startsWith(prefix));
  if (mount === undefined) {
    return undefined;
  }
  const relative = pathname.slice(mount.prefix.length - 1);
  const resolved = path.resolve(mount.directory, `.${relative === '/' ? '/index.html' : relative}`);
  return resolved.startsWith(mount.directory + path.sep) ? resolved : undefined;
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', `http://localhost:${String(PORT)}`).pathname;
  const file = fileFor(pathname);
  const type = file === undefined ? undefined : CONTENT_TYPES.get(path.extname(file));

  if (file === undefined || type === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${pathname}\n`);
    return;
  }

  readFile(file).then(
    (body) => {
      // A developer who rebuilds the library must see that build on reload, not a cached mixture.
      response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    },
    () => {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Not found: ${pathname}\n`);
    },
  );
});

try {
  await readFile(path.join(LIBRARY_DIRECTORY, 'index.js'));
} catch {
  process.stderr.write(
    'node_modules/serial-broker/dist/ is missing or incomplete. Run `npm run build` in the ' +
      'repository root, then `npm install` here.\n',
  );
  process.exit(1);
}

server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Serving the minimal JavaScript example on http://localhost:${PORT}/\n`);
});
