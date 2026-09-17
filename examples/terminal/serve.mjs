/**
 * The development server: `public/` at `/`, and the library files at `/serial-broker/`.
 *
 * A page without a bundler needs two things from `node_modules` on its own origin: the library the
 * import map points at, and the worker script, which a `SharedWorker` can only be created from
 * when it is served as a file with the same URL in every tab. This server maps `/serial-broker/`
 * to `node_modules/serial-broker/dist/`, so both are there without copying anything.
 *
 * It also serves `/stand-in.js`: the repository's Web Serial stand-in, stripped of its types, so
 * `?stand-in` lets the terminal be tried on a machine with no adapter. That path exists in
 * development only - `scripts/build.mjs` does not copy it.
 *
 * Plain Node, no dependencies: a static file server is forty lines, and one fewer package is one
 * fewer thing to audit on a production line.
 */

import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The same port as example.json names; `PORT` overrides it. */
const PORT = Number(process.env['PORT'] ?? '8161');

/** The published library files, as `npm install` put them there. */
const LIBRARY_DIRECTORY = path.join(HERE, 'node_modules', 'serial-broker', 'dist');
/** The stand-in, which lives in the repository's test sources. */
const STAND_IN = path.join(
  HERE,
  '..',
  '..',
  'test',
  'browser',
  'stand-in',
  'web-serial-stand-in.ts',
);

/** Where a URL prefix is served from. The first matching prefix wins, so the longer one is first. */
const MOUNTS = [
  { prefix: '/serial-broker/', directory: LIBRARY_DIRECTORY },
  { prefix: '/', directory: path.join(HERE, 'public') },
];

const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

/**
 * Resolves a URL path below a directory, and refuses anything that would leave it.
 *
 * @param {string} directory
 * @param {string} relative
 */
function resolveWithin(directory, relative) {
  const resolved = path.resolve(directory, `.${relative}`);
  return resolved.startsWith(directory + path.sep) ? resolved : undefined;
}

/**
 * The file a request maps to, or `undefined` when nothing serves that path.
 *
 * @param {string} pathname
 */
function fileFor(pathname) {
  const mount = MOUNTS.find(({ prefix }) => pathname.startsWith(prefix));
  if (mount === undefined) {
    return undefined;
  }
  const relative = pathname.slice(mount.prefix.length - 1);
  return resolveWithin(mount.directory, relative === '/' ? '/index.html' : relative);
}

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', `http://localhost:${String(PORT)}`).pathname;

  if (pathname === '/stand-in.js') {
    readFile(STAND_IN, 'utf8').then(
      (source) => {
        response.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        });
        response.end(stripTypeScriptTypes(source, { mode: 'strip' }));
      },
      () => {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('The stand-in is only available in the repository.\n');
      },
    );
    return;
  }

  const file = fileFor(pathname);
  const type = file === undefined ? undefined : CONTENT_TYPES.get(path.extname(file));

  if (file === undefined || type === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`Not found: ${pathname}\n`);
    return;
  }

  readFile(file).then(
    (body) => {
      // A developer reloading the page after a library build must see that build, not a cached
      // mixture of two.
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
  await readFile(path.join(LIBRARY_DIRECTORY, 'serial-broker.global.js'));
} catch {
  process.stderr.write(
    'node_modules/serial-broker/dist/ is missing or incomplete. Run `npm run build` in the ' +
      'repository root, then `npm install` here.\n',
  );
  process.exit(1);
}

// Loopback only, as the sibling examples bind: a development server has no business answering the
// rest of the network, least of all one that serves a page which drives a serial port.
server.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`Serial-Broker-Terminal on http://localhost:${String(PORT)}/\n`);
  process.stdout.write(`Without a device: http://localhost:${String(PORT)}/?stand-in\n`);
});
