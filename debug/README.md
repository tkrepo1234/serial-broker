# Debugging surface

A single page that shows every setting and every piece of status serial-broker has. It ships in
the package as static content, at `dist/debug/`, and does nothing until someone serves it.

## What it shows

|                                    |                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Platform**                       | Secure context, Web Serial, Web Locks, `SharedWorker`, `BroadcastChannel`, the protocol version, and which transport this tab and the observer ended up on.     |
| **Library settings**               | Everything `configure()` takes: worker URL, transport, `logPayloads`. Plus the level of library log records shown.                                              |
| **Configuration**                  | Every option `setup()` accepts, with presets for common adapters. Set up, choose a device, release, release and revoke the permission.                          |
| **This tab**                       | Every field of `getStatus()` for each configuration, a send box for text or hex, and a log of all four events and the library's own log records.                |
| **The origin**                     | Every tab of the origin, per configuration: role, status, last error, listeners, pending writes, the owner's connection and reconnect timing, and its settings. |
| **Web Locks**                      | Who holds each ownership lock and who is queued behind it.                                                                                                      |
| **Watch**                          | One configuration's traffic, status changes, errors and ownership changes, from whichever tab they happen in.                                                   |
| **Granted ports, remembered ones** | The ports this origin may open, and the configurations `restore()` would set up.                                                                                |

"This tab" is what an application can see. "The origin" is what [ADR-0011](../docs/adr/0011-encapsulation-boundary.md)
keeps from applications and [ADR-0018](../docs/adr/0018-diagnostics-observer.md) makes visible to
operators. They sit side by side on purpose.

The page **sets nothing up on its own**. Opening it to look at a deployment does not make it a
participant, so it never ends up owning a port. Only a configuration you set up here, with the
form, joins the election like any other tab.

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
If it does not, set **Worker URL** under _Library settings_ to the URL the application uses, and
the transport too if the application forces one. The settings are saved in this origin's storage.
To hand someone a link that opens already configured, use _Make a link_, or add the parameters
yourself:

```
/debug/?workerUrl=/assets/serial-broker.worker.js&transport=auto
```

A page on a different worker URL is on a different bus: the origin panel then reports that nobody
answered, and says why.

## Whether to expose it

That is the operator's decision, and it is a real one. The page can **send bytes to devices** and
**revoke device permissions**, and it shows traffic in full. Anyone who can open it on the
application's origin can do what the application can do.

Nothing in the library serves it, links to it or loads it. If it should not be reachable in
production, do not serve `dist/debug/` there.

## Developing it

The sources are `debug/src/` and `debug/public/`. `npm run build` bundles them into `dist/debug/`
along with the library; `npm run debug` builds and serves `dist/` on a local port.
