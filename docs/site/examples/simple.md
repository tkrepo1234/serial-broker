# Simple

The smallest complete page: it connects to a device, asks for permission when it has to, prints
what the device sends, and sends a line. Open it in two tabs and both work.

## The page

```{literalinclude} code/simple/index.html
:language: html
```

## The script

```{literalinclude} code/simple/main.ts
:language: ts
```

## What it does

`setup()` runs on every load, and names no device: the configuration takes it from the port the
user picks. On the first visit nothing has been picked, so the status becomes `awaiting-permission`
and the button appears. After the user has chosen the port once, the configuration remembers
which device it is, later visits open it with no prompt, and the button never shows.

The status listener is told the current status once as soon as it is registered, so the button is
right from the start, whatever happened between `setup()` and `subscribe()`.

`requestAccess()` is called directly in the click handler: the browser only shows its port picker
in response to a click. The browser counts a click as a gesture for a few seconds only; an `await`
that outlasts them loses it.

Nothing in the script refers to tabs. Every tab runs the same code; serial-broker decides which of
them holds the port, and every tab receives the data and can send.

## Running it

Build `main.ts` with any bundler and serve the directory over `localhost`: Web Serial needs a
secure context, which `localhost` counts as.

**The worker script goes with it.** Every tab loads `serial-broker.worker.js` from one URL of the
application's own origin, and no bundler finds it by itself unless it is told to:

```ts
// Vite, and bundlers that understand its syntax:
import workerUrl from 'serial-broker/worker?url';
SerialBroker.configure({ workerUrl });
```

Elsewhere, copy `serial-broker.worker.js` from the package next to the page and name it:
`SerialBroker.configure({ workerUrl: '/serial-broker/serial-broker.worker.js' })`, before the first
`setup()`. Without it the tabs fall back to a `BroadcastChannel` and say so only in the log
([Logging](../diagnostics.md#logging)).

Without a bundler, `tsc` or `esbuild` compiles `main.ts`, an import map in the page's `<head>`
points `serial-broker` at the package's `dist/serial-broker.min.js`, and the worker script is
copied and named as above. [Deploying](../deploying.md) shows the whole arrangement.
