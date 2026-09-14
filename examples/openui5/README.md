# serial-broker in an OpenUI5 application

A runnable OpenUI5 application that talks to a serial device through
[serial-broker](../../README.md), and the reusable integration module it uses:
[`webapp/lib/serialbroker/`](webapp/lib/serialbroker). Copy that folder into your own UI5
application and you have the library as a `JSONModel` you can bind in XML views.

No SAP system, no backend, no cloud: OpenUI5, the application and the library are all served from
one local origin by UI5 Tooling.

## What it shows

- **A status you can bind.** `{reader>/status}` is the serial-broker status; `connected`, `busy`,
  `awaitingPermission`, `canSend` and `canConnect` are derived from it so a view does not have to
  know the status union.
- **Connect from a user gesture.** The _Connect_ button calls `requestAccess()` synchronously from
  the `press` handler - the only way a browser shows its port picker.
- **Received data.** Every line the device sends, and every command any tab sent, in a `sap.m.List`
  bound to `{reader>/lines}`.
- **Sending.** An input and a button, enabled only while the configuration can take a write.
- **Errors with remediation.** A `sap.m.MessageStrip` showing the `SerialBrokerError` code, its
  message and the remediation sentence the library ships for it. A failure the library is already
  recovering from is shown as information, not as an error.
- **Release.** _Release_ gives the configuration up **in this tab only**; the other tabs keep the
  device, and one of them takes the port over.
- **Several configurations at once.** Two configurations - `Reader` (any port) and `Printer` (a
  CH340 by its USB ids) - each with its own model, in one application.
- **One port, every tab.** _Open a second tab_ opens the application again. Both tabs show the same
  status, both receive, both can send; one of them holds the port, and when it closes another takes
  over.

## Running it

The application uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/openui5
npm install
npm start          # serves http://localhost:8150/index.html
```

`npm start` copies the serial-broker broker script into the application's resources (see
[Design decisions](#design-decisions)) and starts the UI5 development server. The first start
downloads OpenUI5 1.148 from npm into the UI5 Tooling cache; later starts are offline.

| Command             | What it does                                                     |
| ------------------- | ---------------------------------------------------------------- |
| `npm start`         | Serves the application at <http://localhost:8150/index.html>.    |
| `npm run typecheck` | `tsc --noEmit` over `webapp/`, including the integration module. |
| `npm run build`     | A static build in `dist/`, for a web server of your own.         |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. Without a device you still see the whole application: the status stays
_Waiting for permission_, and _Connect_ opens the browser's port picker. German texts:
`index.html?sap-ui-language=de`.

### The smoke test

[`smoke.spec.ts`](smoke.spec.ts) drives the application in the installed Edge with the Web Serial
stand-in in place of a device: it clicks _Connect_, sees the status become _Open_, sends `PING`
and sees the loopback device echo it into the traffic list. It loads the page with
`?sap-ui-language=en`, so the texts it asserts are the English bundle's whatever language the
machine speaks. It runs through the repository root, which starts the application on port 8150
first:

```sh
# in the repository root, after `npm run build` there and `npm ci` here
npm run test:examples -- examples/openui5/smoke.spec.ts
```

## Taking the integration module into your own application

1. **Install the library** in your application: `npm install serial-broker`.
2. **Copy `webapp/lib/serialbroker/`** into your application's `webapp/` folder. Two files, no
   dependencies beyond UI5 and serial-broker.
3. **Make the npm package loadable by UI5.** This example uses
   [ui5-tooling-modules](https://www.npmjs.com/package/ui5-tooling-modules) (middleware and task in
   [`ui5.yaml`](ui5.yaml)), which bundles `node_modules` packages into UI5 modules. Any other
   bundler works too - the module only imports the published entry point `serial-broker`.
4. **Serve the broker script from your own origin.** Copy
   `node_modules/serial-broker/dist/serial-broker.worker.js` into your application's resources;
   [`scripts/copy-serial-broker-assets.mjs`](scripts/copy-serial-broker-assets.mjs) is 40 lines and
   does exactly that.
5. **Configure once, in `Component.init()`**, before the first model:

   ```ts
   configureSerialBroker({
     workerUrl: resolveResourceUrl('my/app/serial-broker/serial-broker.worker.js'),
     logger: createUI5Logger(),
   });
   ```

6. **Create a model per device** and set it on the component:

   ```ts
   const scale = new SerialBrokerModel({
     name: 'Scale',
     options: {
       device: { vendorId: 0x0403, productId: 0x6001 },
       serial: { baudRate: 19_200 },
       encoding: { decodeText: true },
     },
   });
   this.setModel(scale, 'scale');
   void scale.start();
   ```

7. **Bind it** in an XML view:

   ```xml
   <ObjectStatus text="{scale>/status}" state="{path: 'scale>/status', formatter: '.formatter.statusState'}" />
   <Button text="{i18n>connect}" press=".onConnect" enabled="{scale>/canConnect}" />
   <List items="{scale>/lines}"><StandardListItem title="{scale>text}" /></List>
   ```

8. **Connect from the gesture**, and nothing else in the handler:

   ```ts
   public onConnect(): void {
     void (this.getView().getModel('scale') as SerialBrokerModel).connect();
   }
   ```

### What the model holds

| Path                                                                    | Meaning                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `/name`                                                                 | The configuration name.                                                  |
| `/supported`                                                            | `false` where the browser has no Web Serial, Web Locks or message bus.   |
| `/started`                                                              | `true` once the configuration is registered in this tab.                 |
| `/status`                                                               | The serial-broker status, unchanged. Treat the set of values as growing. |
| `/connected`, `/busy`, `/awaitingPermission`, `/canConnect`, `/canSend` | Derived flags for bindings.                                              |
| `/lastError`                                                            | `{ code, message, remediation, retryable, timestamp }` or `null`.        |
| `/lines`                                                                | Received and sent lines, newest last, capped at `maxLines`.              |
| `/text`                                                                 | Everything received as one string, capped at `maxTextLength`.            |
| `/receivedBytes`, `/sentBytes`                                          | Byte counters since `start()`.                                           |
| `/device`                                                               | `{ vendorId, productId, baudRate }` once registered.                     |

Methods: `start()`, `connect()`, `send(data)`, `release(options?)`, `reconnect()`, `clearLines()`,
`clearError()`, `getSnapshot()`, `getConfigurationName()`. Events: `serialError`, `statusChange`,
`receive`, each with `attach…`/`detach…` pairs.

## What a developer needs to know

**`requestAccess()` needs a user gesture.** The browser shows its port picker only during the
transient activation of a click, and any `await` before the call consumes it. `connect()` therefore
calls `requestAccess()` synchronously and hands back a promise; never `await` anything before
calling it. Calling it outside a gesture fails with `USER_GESTURE_REQUIRED`.

**The worker script must come from your origin, under one URL.** A `SharedWorker` is identified by
the URL of its script. If two tabs load it from different URLs, they get two workers and share
nothing. Hence the copy into the application's resources and `workerUrl` in `configure()`. Where
the script cannot be loaded at all, serial-broker falls back to a `BroadcastChannel` and keeps
working, and logs `environment.transport-fallback` at warn level - visible in UI5's log through
`createUI5Logger()`.

**One tab holds the port; no tab can tell which.** Every tab sets the same configuration up,
receives the same events and can send. Which tab does the work is deliberately invisible. Do not
write UI that claims "this tab owns the device".

**Statuses, and what to show for each:**

| Status                | What it means                                | What the UI should do                        |
| --------------------- | -------------------------------------------- | -------------------------------------------- |
| `idle`                | Registered, not connecting yet.              | Nothing; it lasts milliseconds.              |
| `queued`              | `maxTabs` other tabs hold the configuration. | Explain the wait; it resolves by itself.     |
| `awaiting-permission` | No granted port matches the device.          | Offer _Connect_ - this is the one gesture.   |
| `connecting`          | Opening the port.                            | Busy indicator; writes are already accepted. |
| `open`                | Connected.                                   | Enable sending.                              |
| `reconnecting`        | Lost, coming back on its own.                | Busy indicator, no error.                    |
| `failed`              | Gave up, or a `maxTabs` conflict.            | Show `lastError.remediation`, offer a retry. |
| `released`            | Given up in this tab.                        | Offer setting it up again.                   |

Treat the union as extensible: a later version may add a status, so fall through to a neutral
state instead of throwing. The example does that in `formatStatusText` and `formatter.statusState`.

**Errors carry their own remediation.** Show `remediation`, not just the message; it is written for
the developer and specific to the code. When `retryable` is `true` the library is already
recovering - show it as information, not as a failure.

**Lifecycle.** The component owns the models and destroys them in `exit()`, which unsubscribes
them. Releasing is deliberately _not_ automatic: a closing tab releases its share anyway, and
releasing on every view exit would disconnect a device the rest of the application still watches.
A model that really owns its device - a dialog for a one-off scan, say - takes
`releaseOnDestroy: true`.

## Design decisions

**OpenUI5 1.148.8, the current long-term maintenance version.** The
[version overview](https://sdk.openui5.org/versionoverview.html) lists 1.148 as _Long-term
Maintenance_ until Q3/2027 - the newest of the long-term versions (1.136 runs out in Q3/2026,
1.120's bug-fix window in Q4/2026). Pinned exactly, in `ui5.yaml` and in `@openui5/types`, so the
example cannot drift under a reader.

**OpenUI5 from npm through UI5 Tooling, not from the CDN.** UI5 Tooling resolves the framework
libraries from npm and serves them from the same origin as the application. That matters here more
than in an ordinary application: Web Serial needs a secure context, the shared worker has to be
same-origin, and an example that also pulls a framework from a CDN would mix two stories. It also
keeps the example working offline after the first start.

**TypeScript with `ui5-tooling-transpile`**, the setup SAP's own TypeScript samples use: sources
stay `.ts` with ES module imports, and Babel turns them into UI5 modules while serving and while
building. `tsc` only type-checks (`npm run typecheck`), which is what CI runs.

**The npm package is made loadable with `ui5-tooling-modules`.** serial-broker is published as an ES
module, and the UI5 loader speaks AMD. The alternative - a hand-written global bridge in
`index.html` - would have cost the types and the import. With the middleware the integration module
simply writes `import { SerialBroker } from 'serial-broker'`, which is also what an application with
webpack or Vite writes.

**The worker is copied into `webapp/serial-broker/` before the server starts**, rather than served
out of `node_modules` by another middleware. One fewer dependency, the same file in `ui5 serve` and
in `ui5 build`, and the URL is one the application controls. The folder is generated and
git-ignored; `npm start` and `npm run build` refresh it.

**`workerUrl` is set explicitly** through `resolveResourceUrl()`, which asks UI5 where the
application's resources are. The library's default resolution uses `import.meta.url`, which does not
survive being bundled into a UI5 module - and the URL has to be identical in every tab anyway.

**The library depends on the repository it lives in** (`"serial-broker": "file:../.."`), so the
example always exercises the working tree. In an application of your own this is
`npm install serial-broker`; nothing else changes.

**Two configurations, not one.** A single one would have left the most common question - "can I
have two devices?" - unanswered. The buttons carry the configuration name as UI5 custom data, so
one handler serves both.

**UI5 classes are annotated, and carry no native private fields.** ui5-tooling-transpile turns a
TypeScript class into a UI5 class (`UIComponent.extend(...)`) only for `*.controller.ts` files and
for classes with a `@namespace` JSDoc tag. Without the tag on `Component.ts`, UI5 fails to create
the component with _"Class constructor Component cannot be invoked without 'new'"_. That conversion
moves the class body into an object literal, where `#private` members are a syntax error - so
everything internal is `private _name` instead. The integration module deliberately has no
`@namespace`, so it stays an ordinary class and can be copied into any application.

**The root ESLint configuration ignores this folder.** UI5 answers to other conventions than the
library does: every module is a default export, an application reads `window` itself, handlers are
passed as unbound methods, and the type-aware rules would need this example's dependencies
installed to say anything true. `npm run typecheck` here is the gate instead, and it runs in CI as
a job of its own. Prettier still formats the folder.

**Stable control ids.** `index.html` fixes the id of both the component container (`container`) and
the component (`serialbroker`), and the root view is `app`, so every DOM id is
`container-serialbroker---app--<control id>` and a test can find controls without guessing. The
ones a test will want, verified in the browser:

| Control              | DOM id                                               |
| -------------------- | ---------------------------------------------------- |
| Connect              | `container-serialbroker---app--connectButton`        |
| Release              | `container-serialbroker---app--releaseButton`        |
| Status               | `container-serialbroker---app--statusIndicator`      |
| Status text only     | `container-serialbroker---app--statusIndicator-text` |
| Error strip          | `container-serialbroker---app--errorStrip`           |
| Send input           | `container-serialbroker---app--sendInput`            |
| Send button          | `container-serialbroker---app--sendButton`           |
| Traffic list         | `container-serialbroker---app--receivedList`         |
| Second configuration | `container-serialbroker---app--printerStatus`        |
| Second Connect       | `container-serialbroker---app--printerConnectButton` |
| Open a second tab    | `container-serialbroker---app--openSecondTabButton`  |

A control that is currently invisible keeps its id on a placeholder named
`sap-ui-invisible-<id>` - that is how UI5 renders `visible="false"`, and it is worth knowing before
a test concludes the control is missing. Two more things the smoke test learned: a `sap.m.Input`
puts its id on a wrapper, and the element that takes keystrokes is `<id>-inner`; and an
`ObjectStatus` keeps its text in `<id>-text`, next to a screen-reader label that would otherwise
end up in the assertion.

**The smoke test starts with an ungranted device.** The stand-in is installed with
`granted: false`, so that the application's own connect path is what runs: a device the origin had
already been granted would open with no click at all, and the click matters - `requestPort()`,
the stand-in's as much as the browser's, needs the transient activation of a real gesture. It
sends with _Append CR LF_ on, as a user would, and takes the counters (`6 bytes received, 6 bytes
sent`) as the proof that the same bytes went out and came back.

**`"type": "module"` in `package.json`.** Playwright decides how to read `smoke.spec.ts` from the
nearest `package.json`, and without the field it treats the file as CommonJS, where the
`import.meta.url` that finds `example.json` is a syntax error. Nothing in the example itself is
CommonJS - the sources are ES modules and the copy script is `.mjs` - so the field costs nothing
and the spec reads like the root's own tests.

**The German bundle is UTF-8, with real umlauts.** UI5 Tooling reads `.properties` files as UTF-8
by default since specification version 2.0 (`propertiesFileSourceEncoding`) and turns every
**The smoke test fixes the language in the URL.** UI5 takes its language from the browser, and the
browser reports the machine's - on a German Windows, Edge under Playwright loads
`i18n_de.properties`, and a test that expects _Waiting for permission_ reads _Wartet auf die
Freigabe_ and times out for a reason that has nothing to do with serial-broker. The
`sap-ui-language` URL parameter wins over the browser's language, so the test loads
`index.html?sap-ui-language=en`. That pins it in the test, where the asserted texts are, rather
than in the root's Playwright configuration, where a `locale` would fix `navigator.language` for
every example but leave the reason a directory away from the assertion.

non-ASCII character into a `\uXXXX` escape while serving and building, which is what the UI5
loader expects. `i18n_de.properties` therefore says _Gerät_, not _Geraet_ - visible at
`index.html?sap-ui-language=de`.

**The i18n model is not `async: true`, and the console says so.** UI5 logs _"Usage of synchronous
loading is deprecated"_ for a `ResourceModel` created without `async: true`. It is a warning about
the model's API mode, not about a synchronous request: for a manifest model the component loader
fetches the bundle asynchronously before it creates the model (`afterPreload` in
`sap/ui/core/Component`). With `async: true`, `getResourceBundle()` returns a promise, and every
formatter in the controller - which needs the bundle synchronously, while rendering - would have
to cache it first. The synchronous model keeps the controller simple, at the price of that one
line in the log.

## Files

```
examples/openui5/
├── example.json                          the manifest the root's test runner reads
├── smoke.spec.ts                         connect, send, echo - in a real browser
├── ui5.yaml                              UI5 Tooling: framework, transpile, npm modules
├── tsconfig.json                         type-check only; @openui5/types
├── scripts/copy-serial-broker-assets.mjs copies the broker script into webapp/
└── webapp/
    ├── index.html                        bootstrap, fixed component id
    ├── manifest.json                     descriptor: root view, i18n model
    ├── Component.ts                      owns the two SerialBrokerModels
    ├── controller/Main.controller.ts     gestures and formatters
    ├── view/Main.view.xml                sap.m controls, bound to the models
    ├── model/formatter.ts                status -> ValueState, icons, times
    ├── i18n/                             English and German bundles
    └── lib/serialbroker/                 THE REUSABLE MODULE
        ├── SerialBrokerModel.ts          JSONModel mirroring one configuration
        └── SerialBrokerSupport.ts        configure, worker URL, UI5 logger, restore
```
