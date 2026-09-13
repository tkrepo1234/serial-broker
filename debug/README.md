# Debugging surface

One page that shows every serial-broker configuration on an origin and lets you act on it where
you see it. It ships in the package as static content, at `dist/debug/`, and does nothing until
someone serves it.

## What it looks like

Every configuration is a **card** — whether it runs in this tab, in other tabs, or is only
remembered from an earlier visit. A card shows:

- its status and device, and a line saying what is going on: waiting for a device, reconnecting
  and when the next try is, running in other tabs;
- **the button that fits the situation**: _Join_ a configuration other tabs run, _Start here_ a
  remembered one, _Choose device…_ when this tab holds the port but has no device yet, _Release_
  when it runs here, and _Forget device_ to also revoke the browser's permission;
- every tab that runs it — which one holds the port, which are waiting, bytes in and out,
  writes still pending, the last error;
- a send box, when it runs in this tab;
- the traffic of every tab, and all of its settings, one click away.

_New configuration_ opens a short dialog: name, device, baud rate. Every other option of
`setup()` is under _More options_. Settings — worker URL, transport, payload logging — and the
browser checks, port locks and granted ports are behind the _Settings_ button. The log
is at the bottom.

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

## Whether to expose it

That is the operator's decision, and it is a real one. The page can **send bytes to devices** and
**revoke device permissions**, and it shows traffic in full. Anyone who can open it on the
application's origin can do what the application can do.

Nothing in the library serves it, links to it or loads it. If it should not be reachable in
production, do not serve `dist/debug/` there.

## Developing it

The sources are `debug/src/` and `debug/public/`. `npm run build` bundles them into `dist/debug/`
along with the library; `npm run debug` builds and serves `dist/` on a local port. Which card shows
which button is decided in `debug/src/model.ts`, which is unit-tested.
