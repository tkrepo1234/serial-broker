# A page with no build step

One HTML file: markup, an import map, and one inline module script. No bundler, no compiler, no
`npm run build` — what you read here is what the browser runs. This is the whole of
[examples/minimal-js](https://github.com/tkrepo1234/serial-broker/tree/main/examples/minimal-js),
which is served by a short static server and covered by a smoke test of its own.

It needs two files served by the application's own origin, at the path the page names — the page
below says `/serial-broker/` in both its import map and its `workerUrl`, so either put them there
or change both strings together: `serial-broker.min.js` (or the readable `serial-broker.js` from
the package) and `serial-broker.worker.js`. Every release attaches them as
`serial-broker-<version>-browser.zip`, which holds the minified build: with it, the import map below
points at `serial-broker.min.js`. [Installing](../installing.md) says which file is which, and
[Deploying to a web server](../deploying.md) covers the headers and what to check afterwards.

```{literalinclude} ../../../examples/minimal-js/index.html
:language: html
```

## What to look at

**The import map is the only "build".** It maps the bare specifier `serial-broker` to the file this
origin serves. Without a map, import the file by its URL instead — the script is the same either
way.

**`configure({ workerUrl })` comes before the first `setup()`.** A `SharedWorker` is identified by
the URL of its script, so every tab has to load the same one, and it has to come from this origin.
This is what makes the tabs share one port rather than each opening its own.

**The connect button is offered exactly while the status is `awaiting-permission`.** The browser
shows its port picker during a click and at no other time, so `requestAccess()` is the first thing
in the handler: a click counts as a gesture for a few seconds only.

**The script is checked.** `npm run typecheck` in that example runs `tsc` with `checkJs` over the
page, against the library's own types, so the JSDoc annotations are not decoration — an example that
fell out of step with the API would fail.

## Assembling lines without a compiler

A delivery is not a line: serial-broker performs no framing, so what arrives is whatever the device
sent while the line was quiet ([Receiving](../guarantees.md#receiving)). The page above prints the
text as it comes, which is right for a log. An application that acts on lines needs to join them,
and the bounded splitter in [All features](all-features.md#reading-lines) is the same code in
TypeScript — and the copy the build type-checks, so it is the one to compare against. In plain
JavaScript, without classes or private fields:

```js
/**
 * Calls `onLine` for each complete line, however the device's output was split into deliveries.
 * Bounded: an unfinished line longer than `maxLength` is noise - a wrong baud rate, a device in
 * another mode - and is dropped rather than kept.
 */
function onLines(name, onLine, { separator = '\r\n', maxLength = 1024 } = {}) {
  let pending = '';

  SerialBroker.subscribe(name, 'onReceive', (event) => {
    // Bytes may be missing before this delivery, so an unfinished line must not be joined to it.
    if (event.afterGap) {
      pending = '';
    }
    pending += event.text ?? '';
    for (;;) {
      const end = pending.indexOf(separator);
      if (end === -1) {
        break;
      }
      onLine(pending.slice(0, end));
      pending = pending.slice(end + separator.length);
    }
    if (pending.length > maxLength) {
      pending = '';
    }
  });
}
```

A tab that joins while the device is already talking starts mid-stream, so its first line can be the
tail of one. Check lines against the device's own format rather than trusting the first.
