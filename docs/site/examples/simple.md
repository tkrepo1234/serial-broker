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

`setup()` runs on every load. On the first visit the browser has not been told which port the
device is, so the status becomes `awaiting-permission` and the button appears. After the user has
chosen the port once, later visits open it with no prompt, and the button never shows.

The script reads the status with `getStatus()` after subscribing, because the status can change
between `setup()` and the moment the listener is registered.

`requestAccess()` is called directly in the click handler. An `await` in front of it would use up
the click, and the browser only shows its port picker in response to one.

Nothing in the script refers to tabs. Every tab runs the same code; serial-broker decides which of
them holds the port, and every tab receives the data and can send.

## Running it

Build `main.ts` with any bundler — or with `tsc` or `esbuild` and an import map pointing
`serial-broker` at the package — and serve the directory over `localhost`. Web Serial needs a
secure context, which `localhost` counts as.
