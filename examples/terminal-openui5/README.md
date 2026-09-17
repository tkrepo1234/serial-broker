# Serial-Terminal in OpenUI5

A serial terminal as a SAP OpenUI5 application in the `sap_horizon` theme: open a port, watch what
the device says, type back. The controls and the look of a Fiori application - and a build that **runs from a folder opened as a file**, with no web
server and no internet.

Classic UI5 JavaScript: `sap.ui.define`, an XML view, a controller, fragments for the dialogs. No
transpile step; the files under `webapp/` are the files the browser loads.

## What it does

- **Connect and Disconnect, and nothing else to learn.** One button with two states.
  _Connect_ always shows the connection settings - baud rate (a combo box: the usual rates, or any
  you type), data bits, stop bits, parity, flow control - filled with the ones used last, then sets
  the connection up and asks for the port in the same click. The dialog stays until there is a
  connection: leave the browser's picker without choosing, and the settings are still there, with a
  line saying that no port was chosen. _Disconnect_ always forgets everything - the browser's
  permission for the port and what serial-broker remembers - so the next _Connect_ starts from
  nothing. That is also how the port, or a setting, is changed.
- **The status badge** shows the library's own word - `connecting`, `open`, `reconnecting`,
  `queued`, `failed` - and `disconnected` while nothing is set up.
- **Send text or hex**, with the line ending you choose. `↑` and `↓` walk through what you sent
  earlier.
- **Display options**: hex view with an offset column and the printable characters beside it, ANSI
  colours, timestamps, auto-scroll, and whether writes are echoed into the log. `Ctrl+H` toggles
  hex.
- **Save the log**, clear the terminal, and - experimental - **send a file** in chunks.
- **`sap_horizon` and `sap_horizon_dark`**, switched with one button, remembered, starting from
  what the system asks for.

Open it in a second tab: both show the same traffic, both can send, and only one holds the port.

## Running it

The example uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/terminal-openui5
npm install
npm start          # serves http://localhost:8162/index.html
```

**Without a device:** open <http://localhost:8162/index.html?stand-in>. That installs the
repository's Web Serial stand-in - a loopback adapter that echoes everything sent. It exists in
development only; a build does not contain it.

| Command             | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `npm start`         | Serves it with UI5 Tooling at <http://localhost:8162/index.html>.     |
| `npm run typecheck` | The repository's `tsc`, with `checkJs` over `webapp/` and `scripts/`. |
| `npm run build`     | Writes `dist/`: the folder that runs from a file.                     |

OpenUI5 1.148 comes from npm through UI5 Tooling, not from a CDN: a station may have no internet.
No SAP system is involved.

## The folder that needs no server

```sh
npm run build
```

Then **open `dist/index.html` in Chrome or Edge** - a double click will do - or copy `dist/` to a
station, a network share or a web server. It is about 10 MB in some fifty files: the page, its
style sheet, the framework as one script, six of its modules, the two themes, and the library.

A UI5 application does not normally survive this. Three things stand in the way of a page opened
from a file, and the build takes each of them away:

1. **No ES modules, no import map.** `index.html` loads serial-broker as its classic script build,
   `serial-broker/serial-broker.global.js`, which puts one global on the page; the controller takes
   the library from there. Every path is relative.
2. **No `XMLHttpRequest`.** OpenUI5 fetches its text bundles, its locale data and a version file
   that way, and the browser refuses all of them for a page opened from a file - the page would
   come up with keys in place of texts. `ui5 build self-contained` puts the modules and the views
   into one script; `scripts/finish-build.mjs` then embeds those remaining files into it, as one
   more `sap.ui.require.preload()` in front of the statement that boots the framework. The module
   loader answers for a resource it has been handed before it asks the network. The page fixes its
   language to English, so one language is enough.
3. **No `SharedWorker`.** The browser starts none for such a page. serial-broker notices and
   coordinates the tabs over a `BroadcastChannel` instead; two tabs still share one port.

What the framework loads with a `<script>` or a `<link>` - a calendar, a lazily loaded part of a
library, the theme - works from a file as it is. Those are six modules and the two themes' style
sheets and fonts, found by opening every part of the built page with every request recorded; the
other 2 600 files of OpenUI5 are never asked for and are not in `dist/`. The smoke test walks the
same path, so a framework update that needs one more module fails there and not on a station.

One thing to know when several applications are opened from files on one machine: to the browser
they all belong to the same place, so they share configuration names. This terminal's is
`Terminal`: another page opened from a file that uses the same name shares its port.

## Taking it into an application of your own

The integration is a handful of calls:

```js
// Component.js - once, before the first setup()
SerialBroker.configure({
  workerUrl: new URL('serial-broker/serial-broker.worker.js', document.baseURI).href,
});

// controller/Terminal.controller.js
// No device named: auto mode. decodeText adds event.text to what is received.
await SerialBroker.setup('Terminal', {
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});
await SerialBroker.requestAccess('Terminal'); // the picker, still within the click on Connect
SerialBroker.subscribe('Terminal', 'onReceive', (event) => show(event.text));
await SerialBroker.send('Terminal', new TextEncoder().encode('PING\r\n'));
await SerialBroker.release('Terminal', { forget: true, forgetDevice: true }); // Disconnect
```

The terminal talks to the library directly, because its log is not a binding (below). An
application that binds controls to a device - a status in an `ObjectStatus`, received lines in a
`List` - would put the same calls behind a `JSONModel` of its own.

## Design decisions

- **The log is plain DOM, not controls.** A terminal holds two thousand lines and gets a new one
  many times a second. `lib/Log.js` appends `div`s to one element a `sap.ui.core.HTML` control
  provides; nothing in it knows about OpenUI5, so it is the part to take elsewhere unchanged.
- **Every colour is a theme variable.** `css/style.css` uses `--sapList_Background`,
  `--sapNegativeTextColor` and their kin, so light and dark need no second set of rules, and the
  ANSI colours follow the theme's palette.
- **State the view shows is a JSON model; state an instance keeps is declared in the class info.**
  `@openui5/types` takes the type of `this` from the object handed to `Controller.extend()`, so the
  fields are there, with `onInit` giving each instance its own values.
- **English only.** The page fixes OpenUI5's language, because a page opened from a file can fetch
  no text bundle and the build embeds exactly one. An application served over http can drop
  `data-sap-ui-language` and translate `i18n.properties` as usual.
- **Its own storage key.** Preferences live under `serial-broker-terminal-openui5/preferences/v1`:
  pages opened from files share one `localStorage`, so a key says whose it is.

## Element ids the smoke test drives

Control ids are stable because the component and the root view have fixed ids
(`index.html`, `manifest.json`): `container-terminal---app--<id>`. The smoke test uses `status`
(its text is `status-text`), `connect` (the one button), `settingsDialog`, `baudRate`,
`connectConfirm`, `settingsCancel`, `connectMessage`, `display`, `optHex`, `optTimestamps`,
`optAutoscroll`, `more`, `fileDialog`, `fileClose`, `theme`, `sendMode`, `sendInput` (the element
that takes text is `sendInput-inner`), `sendEnding`, `sendButton`, `error`, `errorCode`,
`errorRemediation`, `displaySummary` - and `#received`, the log, which is
plain DOM with an id of its own.

`smoke.spec.ts` connects through the dialog, checks the baud rates and that the last settings come
back, that _Disconnect_ forgets everything, that the dialog stays when no port is chosen, an
unplugged adapter, hex across a reload, the size of the log, auto-scroll on and off, two tabs
sharing the port - and builds the application and opens `dist/index.html` from a file in two tabs.
