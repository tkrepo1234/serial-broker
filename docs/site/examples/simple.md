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

The script is [First connection](../first-connection.md) as one file. `setup()` runs on every load
and names no device, so the configuration takes it from the port the user picks. On the first visit
nothing has been picked, the status becomes `awaiting-permission` and the button appears; once the
user has chosen, the device is remembered, later visits open it with no prompt, and the button never
shows. The status listener is told the current status as soon as it is registered, so the button is
right from the start, and `requestAccess()` is called directly in the click, because the browser
shows its port picker only in response to one.

Nothing in the script refers to tabs. Every tab runs the same code; serial-broker decides which of
them holds the port, and every tab receives the data and can send.

## Running it

Build `main.ts` with any bundler and serve the directory over `localhost`, which counts as the
secure context Web Serial needs. The worker script goes with it: every tab loads
`serial-broker.worker.js` from one URL of the application's own origin, and most toolchains have to
be told where it is — see [The worker script](../installing.md#the-worker-script). Without it the
tabs fall back to a `BroadcastChannel` and say so only in the log
([Logging](../diagnostics.md#logging)).

Without a bundler, `tsc` or `esbuild` compiles `main.ts` and an import map in the page's
`<head>` points `serial-broker` at the package's `dist/serial-broker.min.js`.
[Deploying](../deploying.md) shows the whole arrangement.
