# serial-broker in a SAPUI5 application, in JavaScript

A runnable SAPUI5 application that talks to a serial device through
[serial-broker](../../README.md), and the reusable integration module it uses:
[`webapp/lib/serialbroker/`](webapp/lib/serialbroker). Copy that folder into your own UI5
application and you have the library as a `JSONModel` you can bind in XML views.

Written the way a UI5 project that was never migrated to TypeScript is written: `sap.ui.define`
modules, `.extend()` with an object literal, and **no transpile step** - the files under `webapp/`
are the files the browser loads. If your project has an `index.html`, a `Component.js` and a
`manifest.json` and no build pipeline, this is the example to read.

**The same application in TypeScript** is [`examples/openui5`](../openui5/README.md): the same
screens, the same module, the same control ids, with `ui5-tooling-transpile` turning `.ts` sources
into UI5 modules while serving. Reading the two side by side shows exactly what the TypeScript
setup buys and what it costs.

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
cd examples/openui5-js
npm install
npm start          # serves http://localhost:8160/index.html
```

`npm start` copies the serial-broker broker script into the application's resources (see
[Design decisions](#design-decisions)) and starts the UI5 development server. The first start
downloads OpenUI5 1.148 from npm into the UI5 Tooling cache; later starts are offline.

| Command             | What it does                                                          |
| ------------------- | --------------------------------------------------------------------- |
| `npm start`         | Serves the application at <http://localhost:8160/index.html>.         |
| `npm run typecheck` | `tsc --noEmit` with `checkJs` over `webapp/` - see the section below. |
| `npm run build`     | A static build in `dist/`, for a web server of your own.              |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. Without a device you still see the whole application: the status stays
_Waiting for permission_, and _Connect_ opens the browser's port picker. German texts:
`index.html?sap-ui-language=de`.

### The smoke test

[`smoke.spec.ts`](smoke.spec.ts) drives the application in the installed Edge with the Web Serial
stand-in in place of a device: it clicks _Connect_, sees the status become _Open_, sends `PING`
and sees the loopback device echo it into the traffic list. It loads the page with
`?sap-ui-language=en`, so the texts it asserts are the English bundle's whatever language the
machine speaks. It runs through the repository root, which starts the application on port 8160
first:

```sh
# in the repository root, after `npm run build` there and `npm ci` here
npm run test:examples -- examples/openui5-js/smoke.spec.ts
```

The test itself is type-checked by the root, not by this folder: it is in the root's TypeScript
program (`npm run typecheck` at the repository root), and like every file under `examples/` it is
not linted, as [examples/README.md](../README.md) describes.

## Taking the integration module into your own application

1. **Install the library** in your application: `npm install serial-broker`.
2. **Copy `webapp/lib/serialbroker/`** into your application's `webapp/` folder. Two files, no
   dependencies beyond UI5 and serial-broker.
3. **Make the npm package loadable by UI5.** This example uses
   [ui5-tooling-modules](https://www.npmjs.com/package/ui5-tooling-modules) (middleware and task in
   [`ui5.yaml`](ui5.yaml)), which bundles `node_modules` packages into UI5 modules, so that
   `sap.ui.define(['serial-broker'], ...)` resolves. Any other bundler works too.
4. **Serve the broker script from your own origin.** Copy
   `node_modules/serial-broker/dist/serial-broker.worker.js` into your application's resources;
   [`scripts/copy-serial-broker-assets.mjs`](scripts/copy-serial-broker-assets.mjs) is a short
   script that does exactly that.
5. **Configure once, in `Component.init()`**, before the first model:

   ```js
   support.configureSerialBroker({
     workerUrl: support.resolveResourceUrl('my/app/serial-broker/serial-broker.worker.js'),
     logger: support.createUI5Logger(),
   });
   ```

6. **Create a model per device** and set it on the component:

   ```js
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

   Leaving `device` out lets the port the user picks decide.

7. **Bind it** in an XML view:

   ```xml
   <ObjectStatus text="{scale>/status}" state="{path: 'scale>/status', formatter: '.formatter.statusState'}" />
   <Button text="{i18n>connect}" press=".onConnect" enabled="{scale>/canConnect}" />
   <List items="{scale>/lines}"><StandardListItem title="{scale>text}" /></List>
   ```

8. **Connect from the gesture**, and nothing else in the handler:

   ```js
   onConnect: function () {
     void this.getView().getModel('scale').connect();
   },
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

## Type-checking classic UI5 JavaScript

`npm run typecheck` runs `tsc --noEmit` with `allowJs` and `checkJs` over `webapp/`, against
`@openui5/types` and serial-broker's published `.d.ts` files. There is no build step and nothing is
emitted - the check is a linter with a very long memory, and CI runs it for every example. A
misspelt option, a status flag that no longer exists, a formatter renamed in one place only: each
fails the check. Three things are worth knowing before writing `sap.ui.define` modules this way.

**Factory parameters carry their types in JSDoc.** TypeScript does not read the dependency array,
so each parameter says what it is:

```js
sap.ui.define(
  ['sap/ui/core/UIComponent', 'serial-broker'],
  /**
   * @param {typeof import('sap/ui/core/UIComponent').default} UIComponent
   * @param {typeof import('serial-broker')} serialBroker
   */
  function (UIComponent, serialBroker) {},
);
```

`import(...)` in a type annotation resolves the ambient module declarations `@openui5/types` ships,
so `UIComponent` is the real class: its methods are checked, and so is every call into the library.

**`this` inside `.extend()` is already typed.** `@openui5/types` declares the class-info argument
as `ThisType<T & BaseClass>`, so in the object literal `this.byId()`, `this.setProperty()` and the
module's own helpers all resolve, with no annotation at all. Instance fields are the exception:
a field assigned in `constructor` has to be declared in the literal too - which is where
`SerialBrokerModel.js` gets `_settings`, `_subscriptions`, `_partialLine` and `_starting`, each
with a `@type`.

**Types cross module boundaries as global typedefs.** A `sap.ui.define` module is a script, not an
ES module: it exports nothing a `import()` type could reach into. So each module declares the
shapes it hands out - `SerialBrokerModelApi`, `SerialBrokerModelSettings`, `SerialBrokerSupport`,
`SerialBrokerFormatter` - as `@typedef` blocks at file level, where they are global to the program,
and the consuming modules name them in their `@param` annotations. Where the module returns a plain
object, an annotated `const` checks the object against its own typedef before it is returned, so
the two cannot drift apart. `SerialBrokerModel.js` is the one place that cannot do this:
`extend()` is declared as returning a plain `Function`, and a construct signature has nothing
structural in common with it, so the module's last line casts through `unknown` and says so.

The TypeScript sibling needs none of this, and pays a transpiler for it.

## Design decisions

**No transpile step, which is the point.** `examples/openui5` runs `ui5-tooling-transpile` so that
sources can be `.ts` with ES module imports. Here the middleware is simply absent from
[`ui5.yaml`](ui5.yaml): what the browser loads is what is in `webapp/`, and a developer can open the
Sources panel and find the file they edited. Debugging a UI5 application whose modules are the
files on disk is the reason many projects stayed on JavaScript.

**OpenUI5 1.148.8, the current long-term maintenance version.** The
[version overview](https://sdk.openui5.org/versionoverview.html) lists 1.148 as _Long-term
Maintenance_ until Q3/2027. Pinned exactly, in `ui5.yaml` and in `@openui5/types`, so the example
cannot drift under a reader - and the same version as the TypeScript sibling, so the two differ in
language and nothing else.

**OpenUI5 from npm through UI5 Tooling, not from the CDN.** UI5 Tooling resolves the framework
libraries from npm and serves them from the same origin as the application. That matters here more
than in an ordinary application: Web Serial needs a secure context, the shared worker has to be
same-origin, and an example that also pulls a framework from a CDN would mix two stories. It also
keeps the example working offline after the first start.

**The npm package is made loadable with `ui5-tooling-modules`.** serial-broker is published as an
ES module, and the UI5 loader speaks AMD. With the middleware, `sap.ui.define(['serial-broker'],
...)` resolves to the package from `node_modules`, which is the same dependency name the
TypeScript sibling's `import` compiles to. The alternative - a hand-written global bridge in
`index.html` - would have cost the types and the one-line dependency.

**The worker is copied into `webapp/serial-broker/` before the server starts**, rather than served
out of `node_modules` by another middleware. One fewer dependency, the same file in `ui5 serve` and
in `ui5 build`, and the URL is one the application controls. The folder is generated and
git-ignored; `npm start` and `npm run build` refresh it.

**`workerUrl` is set explicitly** through `resolveResourceUrl()`, which asks UI5 where the
application's resources are. The library's default resolution uses `import.meta.url`, which a UI5
module has no equivalent of - and the URL has to be identical in every tab anyway.

**`.extend()` with an object literal, not an ES class.** UI5 1.148's class system builds its
classes with `extend()`, and a native `class` is not a drop-in replacement: UI5 calls the
constructor without `new` in places, which a native class refuses with _"Class constructor cannot
be invoked without 'new'"_. The TypeScript sibling writes classes and has them converted; here the
conversion is what is written down.

**Two configurations, not one.** A single one would have left the most common question - "can I
have two devices?" - unanswered. The buttons carry the configuration name as UI5 custom data, so
one handler serves both.

**The German bundle is UTF-8, with real umlauts.** UI5 Tooling reads `.properties` files as UTF-8
by default since specification version 2.0 and escapes every non-ASCII character while serving and
building, which is what the UI5 loader expects. `i18n_de.properties` therefore says _Gerät_, not
_Geraet_ - visible at `index.html?sap-ui-language=de`.

**`"type": "module"` in `package.json`.** Playwright decides how to read `smoke.spec.ts` from the
nearest `package.json`, and without the field it treats the file as CommonJS, where the
`import.meta.url` that finds `example.json` is a syntax error. Nothing in the application itself is
an ES module - the `webapp/` sources are AMD and the copy script is `.mjs` - so the field costs
nothing and the spec reads like the root's own tests.

**The root ESLint configuration ignores this folder, the smoke test included**, as it does every
example. UI5 answers to other conventions than the library does, and the type-aware rules would
need this example's dependencies installed to say anything true. `npm run typecheck` here is the
gate for `webapp/`, and it runs in CI as a job of its own. Prettier still formats the folder.

**Stable control ids.** `index.html` fixes the id of both the component container (`container`) and
the component (`serialbroker`), and the root view is `app`, so every DOM id is
`container-serialbroker---app--<control id>` - the same ids as the TypeScript sibling, so one smoke
test shape serves both:

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

A control that is currently invisible keeps its id on a placeholder named `sap-ui-invisible-<id>` -
that is how UI5 renders `visible="false"`. Two more things worth knowing: a `sap.m.Input` puts its
id on a wrapper, and the element that takes keystrokes is `<id>-inner`; and an `ObjectStatus` keeps
its text in `<id>-text`, next to a screen-reader label that would otherwise end up in an assertion.

## Files

```
examples/openui5-js/
├── example.json                          the manifest the root's test runner reads
├── smoke.spec.ts                         connect, send, echo - in a real browser
├── ui5.yaml                              UI5 Tooling: framework and npm modules, no transpiler
├── tsconfig.json                         checkJs over webapp/; @openui5/types
├── scripts/copy-serial-broker-assets.mjs copies the broker script into webapp/
└── webapp/
    ├── index.html                        bootstrap, fixed component id
    ├── manifest.json                     descriptor: root view, i18n model
    ├── Component.js                      owns the two SerialBrokerModels
    ├── controller/Main.controller.js     gestures and formatters
    ├── view/Main.view.xml                sap.m controls, bound to the models
    ├── model/formatter.js                status -> ValueState, icons, times
    ├── i18n/                             English and German bundles
    └── lib/serialbroker/                 THE REUSABLE MODULE
        ├── SerialBrokerModel.js          JSONModel mirroring one configuration
        └── SerialBrokerSupport.js        configure, worker URL, UI5 logger, restore
```
