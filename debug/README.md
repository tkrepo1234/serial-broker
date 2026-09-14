# Debugging surface

One page that shows every serial-broker configuration on an origin and lets you act on it where
you see it. It ships in the package as static content, at `dist/debug/`, and does nothing until
someone serves it.

## What it looks like

The page lists **every configuration** on the origin — whether it runs in this page, in other tabs,
or is only remembered from an earlier visit — with its status, its device, how many tabs use it,
and whether this page is connected to it.

Choosing one shows it in detail, with **one button for the next step**: _Connect_ to use a
configuration from this page, or _Choose device…_ when this page holds the port but has no device
yet. The **⋯** menu holds the rest: _Edit settings…_, _Disconnect_, and _Disconnect and forget
device_, which also revokes the browser's permission. The detail has three sections:

- **Overview** — every tab that uses it, which one holds the port and which are waiting, when the
  port opened, the next reconnect attempt, bytes in and out, pending writes, the last error;
- **Traffic** — the traffic of every tab, and a send box while this page is connected;
- **Settings** — every setting, grouped as the dialog asks for them, and _Edit settings…_.

_New configuration_ opens a short dialog: name, device, baud rate. Every other option of `setup()` is
under _More options_. Editing opens the same dialog on the settings in use; saving disconnects this
page and connects again with the new settings, while other tabs keep theirs. A **?** beside a
setting or a section opens a short explanation of it. Settings of the page itself — worker URL,
transport, payload logging — and the browser checks, port locks and granted ports are behind the
_Settings_ button. The log is at the bottom.

The page refreshes on its own and **sets nothing up on its own**: opening it to look never makes
it a participant, so it never ends up owning a port.

## Serving it

It is plain static files. Serve the package's `dist/` directory, or copy `dist/debug/` and
`dist/serial-broker.worker.js` next to each other, under the application's origin:

```
dist/
├── serial-broker.worker.js
└── debug/
    ├── index.html
    └── debug.js
```

It must be on the **same origin** as the application, because tabs of different origins never
share anything, and in a **secure context** — HTTPS, or `localhost`.

### Pointing it at the application's bus

A `SharedWorker` is identified by its script URL. By default the page loads the worker next to
itself, which is only the application's worker if the application serves it from the same place.
If it does not, set the **Worker URL** under _Settings_ to the URL the application uses, and the
transport too if the application forces one. _Copy link_ gives a link that opens the page with
those settings:

```
/debug/?workerUrl=/assets/serial-broker.worker.js&transport=auto
```

A page on a different worker URL is on a different bus and shows nothing running.

A worker URL is a script the page runs with the rights of the application's origin, and anyone can
send a link. So when a link names a worker URL other than the one the page would use anyway, the
page asks before it starts, and declining keeps the page on its saved or default worker. A URL of
another origin, or a `data:` or `blob:` URL, is never used: no `SharedWorker` could reach the
application's bus from it.

## Whether to expose it

That is the operator's decision, and it is a real one. The page can **send bytes to devices** and
**revoke device permissions**, and it shows traffic in full. Anyone who can open it on the
application's origin can do what the application can do.

Nothing in the library serves it, links to it or loads it. If it should not be reachable in
production, do not serve `dist/debug/` there.

If it is served, serve it behind the same authentication as the application's own administration,
and send headers the page cannot set for itself:

```text
Content-Security-Policy: default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'
Referrer-Policy: no-referrer
```

`frame-ancestors` keeps other sites from framing the page and laying their own content over its
buttons. The page also refuses to start inside a page of another origin, for servers that send no
such header.

## Developing it

The sources are `debug/src/` and `debug/public/`. `npm run build` bundles them into `dist/debug/`
along with the library; `npm run debug` builds and serves `dist/` on a local port. Which configuration
offers which action is decided in `debug/src/model.ts`, which is unit-tested.
