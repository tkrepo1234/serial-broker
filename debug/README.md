# Debugging surface

One page that shows every serial-broker configuration on an origin and lets you act on it where
you see it. It ships in the package as static content, at `dist/debug/`, and does nothing until
someone serves it.

It is also where you start with the library: serve it, open it, press **Choose a device…**, and
you are talking to your device — no vendor ID, no product ID, nothing to install.

## Starting with a device

**Choose a device…**, the page's main action, proposes a configuration with no device named:

- a **name** no configuration on this origin uses yet, `Device` or `Device 2`;
- the **baud rate**, starting at 9600, with the common rates in the list, and every other line
  setting at the library's default under _More options_.

Change what your device needs and press **Connect**. The configuration is set up in the library's
_auto mode_ and the browser's own port picker opens with no filter, in that same click, so every
port it offers is in the list: USB adapters, built-in RS-232 ports, virtual COM ports, Bluetooth
serial ports. Pick the one your device is on. The configuration takes its identity from that port
— its USB vendor and product IDs, or the fact that it has none — and remembers it, so this visit
and every later one connect without asking again, and other tabs that set the same name up
without a device follow it. Closing the picker without choosing sets nothing up.

Where several ports the browser allows match the chosen device, the configuration opens the first
of them: identical devices report identical IDs, and the log says so.

## What it looks like

The page lists **every configuration** on the origin — whether it runs in this page, in other tabs,
or is only remembered from an earlier visit — with its status, its device, how many tabs use it,
and whether this page is connected to it.

Choosing one shows it in detail, with **one button for the next step**: _Connect_ to use a
configuration from this page, or _Choose device…_ when the configuration has no device yet and this
page uses it — whichever tab holds the port, but not while this page is queued for a place or has
withdrawn. The **⋯** menu holds the rest: _Edit settings…_, _Disconnect_, and _Disconnect and forget
device_, which also revokes the browser's permission. The detail has three sections:

- **Overview** — every tab that uses it, which one holds the port and which are waiting, when the
  port opened, the next reconnect attempt, bytes in and out, pending writes, the last error;
- **Traffic** — the traffic of every tab, and a send box while this page is connected;
- **Settings** — every setting, grouped as the dialog asks for them, and _Edit settings…_.

_Choose a device…_ sets one up for a port you pick in the browser's picker. _New configuration_
opens the same dialog with the device list: _Automatic (from the chosen device)_ by default, the
common adapters, _Other USB device_ for IDs you know, _Port without USB identity_ and _Any port_.
Every other option of `setup()` is under _More options_. Editing opens the same dialog on the settings in use; saving disconnects this
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
    ├── debug.css
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

If it is served, serve it behind the same authentication as the application's own administration.

The page carries a policy of its own, in a `<meta>` element, so it holds wherever it is served
(ADR-0034):

```text
default-src 'none'; script-src 'self'; worker-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'
```

It has no inline script and no inline style, so nothing in it needs `'unsafe-inline'`. A copy of
the page that something rewrites — an injected script, a changed stylesheet — stops working rather
than running the change.

Two things a page cannot set for itself, to send as headers:

```text
Content-Security-Policy: frame-ancestors 'self'
Referrer-Policy: no-referrer
```

`frame-ancestors` keeps other sites from framing the page and laying their own content over its
buttons; a `<meta>` element cannot carry it. The page also refuses to start inside a page of
another origin, for servers that send no such header.

## Developing it

The sources are `debug/src/` and `debug/public/`, the page's markup and stylesheet in the latter.
`npm run build` bundles them into `dist/debug/` along with the library; `npm run debug` builds and
serves `dist/` on a local port. Which configuration offers which action is decided in
`debug/src/model.ts`, and what a port chosen in the picker becomes in `debug/src/chosen-port.ts`;
both are unit-tested.

Keep the page free of inline script and inline style, including `style` attributes, or its own
content security policy will refuse what you add.
