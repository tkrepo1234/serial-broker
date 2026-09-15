# Deploying to a web server

How to put a page that uses serial-broker on a static web server that has no npm: which files to
copy, the headers to send, and what to check afterwards. The examples use nginx over HTTPS and a
strict content security policy, and a page that loads the library without a bundler. A bundled
application needs the same headers; its bundler emits the library, and only the worker script is
copied as described in [The worker script](installing.md#the-worker-script).

## Which files to copy

On a machine with npm, `npm install serial-broker` and take the files from
`node_modules/serial-broker/dist/`:

| File                          | Needed                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `index.min.js`                | Yes. The library, one file that imports nothing else.                                                      |
| `serial-broker.worker.js`     | Yes. The script every tab starts as its `SharedWorker`; it imports nothing.                                |
| `index.min.js.map`            | Optional. Readable stack traces in the browser's developer tools.                                          |
| `serial-broker.worker.js.map` | Optional, as above.                                                                                        |
| `diagnostics.min.js` and map  | Only for a support page that imports `serial-broker/diagnostics/min`.                                      |
| `debug/`                      | Only if you decided to serve the debugging surface; see [Diagnostics](diagnostics.md#whether-to-serve-it). |

Put the library files in one directory of the application's origin, the worker next to
`index.min.js`:

```text
/srv/scale/                       served as https://scale.plant.example/scale/
├── index.html
├── app.js
├── app.css
└── vendor/serial-broker/
    ├── index.min.js
    ├── index.min.js.map
    ├── serial-broker.worker.js
    └── serial-broker.worker.js.map
```

The library makes no network requests of its own and loads nothing else: no styles, no further
scripts, no data. It uses Web Serial, Web Locks, a `SharedWorker` or `BroadcastChannel`, and
`localStorage`, none of which a content security policy governs except the worker script.

## One base for the import map and the worker

The import map names where the library lives; `workerUrl` names where the worker lives. Under a
sub-path both change together, so derive the worker URL from the library's resolved address and keep
the path in one place:

```html
<script type="importmap">
  { "imports": { "serial-broker/min": "/scale/vendor/serial-broker/index.min.js" } }
</script>
<script type="module" src="/scale/app.js"></script>
```

```js
import { SerialBroker } from 'serial-broker/min';

// https://scale.plant.example/scale/vendor/serial-broker/serial-broker.worker.js
SerialBroker.configure({
  workerUrl: new URL('serial-broker.worker.js', import.meta.resolve('serial-broker/min')),
});
```

The specifier is `serial-broker/min`, the package's export for the minified build, so the same
import resolves to the same file under a bundler and to its type definitions in an editor. Any
specifier works as long as the script imports the one the map names.

Without `configure()`, the library looks for `serial-broker.worker.js` next to its own file, which
gives the same URL for this layout. Naming it keeps the one URL every tab must share visible.

A `SharedWorker` is identified by its **resolved** URL. Two pages whose relative `workerUrl` strings
resolve to the same address share one worker; a relative string such as
`'vendor/serial-broker/serial-broker.worker.js'` resolves against each page's own address and gives
pages under different paths different workers. A query string makes a different URL too:
`serial-broker.worker.js?v=2` is a worker of its own. `import.meta.resolve()` returns an absolute
address, so every page that loads the library from the same file names the same worker.

## Content security policy

A policy that allows only what such a page needs:

```text
Content-Security-Policy: default-src 'none'; script-src 'self' 'sha256-…'; worker-src 'self';
  style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

`script-src 'self'`
: The page's scripts and `index.min.js`.

`'sha256-…'` in `script-src`
: The inline import map. Under `script-src` an import map is an inline script, and browsers do not
load one from a `src` attribute, so it needs a hash (or a nonce, which a static server cannot
generate). The hash covers the exact text between `<script type="importmap">` and `</script>`,
spaces and line breaks included, so hash the file as the server delivers it — after any formatter
has run. Compute it wherever the page is built, and again whenever the map changes:

```sh
node -e "const html = require('fs').readFileSync('index.html', 'utf8'); const map = /<script type=\"importmap\">([\s\S]*?)<\/script>/.exec(html)[1]; console.log(\"'sha256-\" + require('crypto').createHash('sha256').update(map, 'utf8').digest('base64') + \"'\")"
```

A blocked import map is reported on the console, and the report names the hash it expected. A page
that imports the library by its URL instead —
`import { SerialBroker } from '/scale/vendor/serial-broker/index.min.js'` — has no inline script and
needs no hash.

`worker-src 'self'`
: The worker script. Blocked, the tab falls back to a `BroadcastChannel` with the default
`transport: 'auto'` and logs `environment.transport-fallback`; with `transport: 'sharedworker'`,
`setup()` fails with `BROKER_UNAVAILABLE`.

`style-src`, `img-src`, `form-action`
: The page's own stylesheet, icon and forms. serial-broker needs none of them, nor `connect-src`:
add what the application itself loads.

`frame-ancestors 'none'`
: Keeps other sites from framing the page. It works only as a header; a `<meta>` policy ignores it.

The worker gets its policy from the headers of its own response. The same header on every file is
fine: the worker loads nothing.

**Trusted Types.** A policy with `require-trusted-types-for 'script'` makes the browser treat the
worker URL as a script URL. The library passes a plain URL, so without a `default` Trusted Types
policy that accepts it, creating the worker throws, and the tab falls back to a `BroadcastChannel`
as for a blocked worker. Leave that directive out, or define such a policy.

## MIME types

Module scripts and module workers load only with a JavaScript MIME type: `text/javascript`, or
`application/javascript` as the `mime.types` file of nginx names it. Every file serial-broker ships
ends in `.js`. If the application's own scripts end in `.mjs`, check that the server maps that
extension too; many default tables do not. A script with the wrong type fails to load, and a worker
script that fails to load becomes a silent fallback under `transport: 'auto'`, so check it after
deploying.

## Cache headers

A worker script left in a cache from an earlier release runs another protocol version: the tab
reports `PROTOCOL_VERSION_MISMATCH`, and with `transport: 'auto'` moves to a `BroadcastChannel` (see
[the error](errors.md#coordination-between-tabs)). Two ways avoid it:

- **Revalidate.** Serve the library, the worker script and the page with `Cache-Control: no-cache`.
  The browser keeps its copy but asks the server on every load, and a file that has not changed
  costs a `304` answer. This keeps the worker URL the same across releases, which is what the tabs
  share.
- **Versioned URLs.** Put each release under its own path, `vendor/serial-broker/0.2.0/`, and
  serve it with a long `max-age`. The import map, and with it the worker URL, then changes with
  every release — and tabs still open from before the deploy keep the old worker. If the release
  did not change the protocol version, the old tabs and the new ones wait for the same port but
  are on different workers, and do not see each other; see
  [Tabs on different message buses](known-limits.md#tabs-on-different-message-buses). Reload every
  tab after each deploy.

Either way, reload the open tabs after deploying a release that changes the protocol; the
changelog says when.

## Permissions policy

A site that sends a `Permissions-Policy` header has to allow Web Serial for itself:

```text
Permissions-Policy: serial=(self)
```

The feature is called `serial`. Blocked, `setup()` still resolves, and the first connection attempt
fails with `WEB_SERIAL_UNAVAILABLE` through `onError`. serial-broker uses no other feature a
permissions policy controls.

## nginx

The headers in one file, included in every `location`: nginx drops the `add_header` lines of the
`server` block in a `location` that has `add_header` lines of its own, and including the same file
everywhere avoids that trap.

```nginx
# /etc/nginx/snippets/scale-headers.conf
add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'sha256-REPLACE'; worker-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
add_header Permissions-Policy "serial=(self)" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "no-referrer" always;
add_header Cache-Control "no-cache" always;
```

```nginx
server {
    listen 443 ssl;
    server_name scale.plant.example;
    ssl_certificate     /etc/nginx/tls/scale.plant.example.crt;
    ssl_certificate_key /etc/nginx/tls/scale.plant.example.key;

    include mime.types;
    root /srv;

    location /scale/ {
        include snippets/scale-headers.conf;
        try_files $uri $uri/ =404;
    }
}

# One origin: every other name of the host redirects, so that no tab runs on an origin of its own.
server {
    listen 443 ssl;
    server_name scale scale.plant;
    ssl_certificate     /etc/nginx/tls/scale.plant.example.crt;
    ssl_certificate_key /etc/nginx/tls/scale.plant.example.key;
    return 301 https://scale.plant.example$request_uri;
}
```

`etag` is on by default, so `no-cache` answers an unchanged file with `304`.

## Where tabs coordinate

Tabs share a port only with tabs of the same origin **in the same browser profile on the same
computer**. Web Locks, the `SharedWorker` and the `BroadcastChannel` all belong to the profile: a
second browser, a second profile, an incognito or guest window, or another computer's tabs never
see this one's, and each of them tries to hold the device on its own. A page embedded in a page of
another site runs in a partitioned context in Chromium and does not coordinate with the application's
own tabs either.

A technician checks a station from the station itself, not from their own computer.

## After deploying

1. **The files load.** In the developer tools' _Network_ panel, `index.min.js` and
   `serial-broker.worker.js` answer `200` or `304`, with a JavaScript `Content-Type` and
   `Cache-Control: no-cache`. The console shows no content security policy violation.
2. **One worker.** With two or more tabs of the application open, `chrome://inspect/#workers` lists
   exactly one shared worker for `serial-broker.worker.js`, at the URL you configured. Two entries
   mean two URLs — a relative `workerUrl`, a query string, a second host name — or tabs from before
   a deploy that changed the protocol.
3. **No fallback.** The application's logger records no `environment.transport-fallback`. On a
   staging system, `transport: 'sharedworker'` makes a missing or blocked worker fail loudly with
   `BROKER_UNAVAILABLE` instead.
4. **Every tab from the same URL.** Every tab shows the same host name in its address bar, and every
   page names the worker by the same absolute URL.
5. **Tabs cooperate.** Open two tabs: both show the same status and receive the same data, both can
   send, and closing either one leaves the other connected.
6. **After every deploy,** reload every open tab of the application.

On a station, a technician checks, in this order: the address bar (the usual host name), that
every window is in the same browser profile, `chrome://inspect/#workers` (one shared worker), and
the application's log for `environment.transport-fallback` and `PROTOCOL_VERSION_MISMATCH`.
