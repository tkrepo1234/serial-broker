# serial-broker in a Svelte 5 application

A runnable Svelte 5 application that talks to a serial device through
[serial-broker](../../README.md), and the reusable module it uses:
[`src/lib/serial-broker.svelte.ts`](src/lib/serial-broker.svelte.ts). Copy that one file into your
own Svelte 5 project and one configuration becomes reactive state you read in markup:

```svelte
<script lang="ts">
  import { createSerialBroker } from './lib/serial-broker.svelte.ts';

  // Set up when the component mounts, released when it is destroyed.
  const device = createSerialBroker('Device', {
    device: { any: true }, // or { vendorId: 0x1a86, productId: 0x7523 } for one kind of device
    serial: { baudRate: 9600 },
    encoding: { decodeText: true },
  });
</script>

<p>{device.status}</p>
{#if device.needsPermission}
  <!-- connect() first in the handler: the browser shows its port picker during a click only. -->
  <button onclick={() => device.connect()}>Choose device…</button>
{/if}
{#if device.error}
  <p>{device.error.code}: {device.error.remediation}</p>
{/if}
<pre>{device.received}</pre>
<button disabled={!device.canSend} onclick={() => device.send('PING\r\n')}>Send</button>
```

Plain Svelte with Vite and TypeScript, no SvelteKit. Open the page in two tabs: both show the same
status, both receive, both can send. One of them holds the port; close it, and another takes over.
Nothing in the code refers to tabs.

## What it shows

- **A reusable module with runes.** `createSerialBroker(name, options)` returns an object whose
  properties - `status`, `error`, `received`, `canSend`, `needsPermission` and a few more - are
  `$state` behind getters, and whose methods are the actions: `connect()`, `send()`, `release()`,
  `restart()`, `clearError()`, `clearReceived()`. Markup reads the properties and Svelte updates
  what depends on them; nothing outside the module can assign them.
- **Cleanup on destroy.** The configuration is set up when the component mounts. When the
  component is destroyed, the subscriptions end and the configuration is released in this tab; a
  component created again at once waits for that release to close the port first.
- **Every status, named and explained.** `idle`, `queued`, `awaiting-permission`, `connecting`,
  `open`, `reconnecting`, `failed` and `released` each have one sentence for the person at the
  screen, in [`src/status-text.ts`](src/status-text.ts). A status the page does not know is shown
  with its name. This page sets no `maxTabs`, so it never shows `queued`; the sentence is there for
  an application that does.
- **The connect button only where a click is needed.** _Choose device…_ exists while the status is
  `awaiting-permission` and at no other time. A closed picker is a note, not an error.
- **Errors with code, message and remediation**, from `onError` and from every call. A retryable
  error - one the library is already recovering from - is marked as such, and cleared once the port
  is open again.
- **Release and the way back.** _Release in this tab_ gives the device up here while the other
  tabs keep it; _Set up again_ rejoins, and after `failed` it releases the failed configuration
  first.
- **Received text and counters**, the last 20 000 characters, and the bytes received and sent by
  any tab.
- **Nothing on the console.** The smoke test fails on any console warning or error.

## Running it

The application uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/svelte
npm install
npm start          # serves http://localhost:8157/
```

| Command             | What it does                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| `npm start`         | Vite's development server at <http://localhost:8157/>.                      |
| `npm run typecheck` | `svelte-check` over `src/` - the `.svelte` files and the `.ts` files alike. |
| `npm run build`     | A production build in `dist/`, worker script included, for a web server.    |
| `npm run preview`   | Serves `dist/` on the same port, to check the build.                        |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. With a serial adapter plugged in, _Choose device…_ opens the browser's port
picker; bridging the adapter's TX and RX pins turns it into a loopback that echoes every line.
Without a device, open <http://localhost:8157/?stand-in>: the page then installs the Web Serial
stand-in from the repository's browser tests, a granted loopback adapter. The flag works in the
development server only; the production build leaves the stand-in out.

### The smoke test

```sh
# in the repository root, after `npm run build` there and `npm install` here
npm run test:examples -- examples/svelte/smoke.spec.ts
```

[`smoke.spec.ts`](smoke.spec.ts) runs in the installed Edge with the stand-in installed before the
page loads. It opens the page with a granted device and sees it reach `open` without a click, sends
a line and sees it echoed, unplugs the device and sees `reconnecting` with a retryable
`DEVICE_DISCONNECTED`, plugs it in again and sends once more; opens the page with an ungranted
device and connects with a real click on _Choose device…_; and opens two tabs, sees the second
receive what the first sends, releases in the first while the second keeps sending, and sets up
again.

## Taking it into your own application

1. **Install the library:** `npm install serial-broker`.
2. **Copy [`src/lib/serial-broker.svelte.ts`](src/lib/serial-broker.svelte.ts)** into your project.
   One file; it imports `svelte` and `serial-broker` and nothing else. Keep the `.svelte.ts`
   extension: it is what lets Svelte compile the runes in it.
3. **Name the worker script, once for the page**, before the first component mounts - as
   [`src/main.ts`](src/main.ts) does:

   ```ts
   import { SerialBroker } from 'serial-broker';
   import workerUrl from 'serial-broker/worker?url';

   SerialBroker.configure({ workerUrl });
   ```

   A `SharedWorker` is identified by the URL of its script, so every tab has to load it from the
   same URL of your origin. Vite's `?url` import serves the file while developing and copies it
   into the build. With another toolchain, copy
   `node_modules/serial-broker/dist/serial-broker.worker.js` to your static files and pass that
   path instead.

4. **Optionally, say goodbye on `pagehide`** with `SerialBroker.dispose()`, also in `main.ts`. A
   closing tab destroys no components, so this is what lets another tab take the port over at once.
   Without it the browser still frees everything as the tab dies. With it, also reload the page on
   `pageshow` with `event.persisted` set: a page the browser restores from the back/forward cache
   would otherwise show the state from before `dispose()`.
5. **Call `createSerialBroker()` at the top level of a component's `<script>`**, with your device's
   USB ids and baud rate. On Windows the ids are in Device Manager under _Hardware Ids_
   (`VID_1A86&PID_7523`), or leave `device` out to let the port the user picks decide. Every tab
   must pass the same name and options.
6. **Show the status**, a connect button while `needsPermission`, and `error.code` with
   `error.remediation`. Call `connect()` first thing in the click handler - no `await` before it.
7. **Decide who owns the configuration.** The default releases it when the component is destroyed.
   When other code in the same tab keeps using the configuration, pass
   `{ releaseOnDestroy: false }`. For a connection that lives as long as the page rather than a
   component, create it inside `$effect.root()`, whose cleanup ends it.
8. **Parse the stream where you need to.** `received` is text for display. A protocol parser
   subscribes to the configuration itself -
   `SerialBroker.subscribe(device.name, 'onReceive', ...)` - once `device.isSetUp` is `true`.

### What the connection exposes

| Property                          | Meaning                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `name`                            | The configuration name.                                                             |
| `status`                          | The serial-broker status, unchanged. `idle` before setup, `failed` if setup failed. |
| `since`                           | Epoch milliseconds at which the status was entered.                                 |
| `isSetUp`                         | The configuration is set up in this tab - also in `failed`.                         |
| `needsPermission`                 | `status === 'awaiting-permission'`: the connect button belongs on screen.           |
| `canSend`                         | `status === 'open'`.                                                                |
| `error`                           | The latest `SerialBrokerError`, or `null`.                                          |
| `received`                        | Received text, the last `maxReceivedLength` characters (20 000 by default).         |
| `receivedBytes`, `sentBytes`      | Byte counters since the last setup; `sentBytes` counts every tab's writes.          |
| `connect()`                       | The port picker. Resolves `'granted'`, `'dismissed'` or `'failed'`; never rejects.  |
| `send(data)`                      | Resolves `true` once the browser took the bytes, `false` with `error` set.          |
| `release()`, `restart()`          | Give up what this connection set up; release that if needed and set up again.       |
| `clearError()`, `clearReceived()` | Empty `error` or `received`.                                                        |

## Stable element ids

| Element                             | Id                                                 |
| ----------------------------------- | -------------------------------------------------- |
| Status word, as the library reports | `status`                                           |
| One sentence about the status       | `status-hint`                                      |
| Time the status was entered         | `status-since`                                     |
| Connect (`awaiting-permission`)     | `connect`                                          |
| Release in this tab                 | `release`                                          |
| Set up again                        | `restart`                                          |
| Open a second tab                   | `open-second-tab`                                  |
| Error panel (absent if none)        | `error`                                            |
| Error code, message, remediation    | `error-code`, `error-message`, `error-remediation` |
| "recovering by itself" note         | `error-recovering`                                 |
| Dismiss the error                   | `dismiss-error`                                    |
| Send form, input and button         | `send-form`, `send-input`, `send-button`           |
| Received text                       | `received`                                         |
| Byte counters                       | `counters`                                         |
| Clear the received text             | `clear-received`                                   |

`#status` also carries the value in `data-status`, and `#error` carries `data-retryable`, for
styling. Elements that do not apply are not rendered, rather than hidden: a test looks for them to
be absent, which Playwright's `toBeHidden()` accepts.

## Design decisions

**Plain Svelte with Vite, not SvelteKit.** SvelteKit adds routing and server-side rendering, and
Web Serial exists in the browser only: an example built on it would spend its lines on keeping
the library off the server. The module works in a SvelteKit application unchanged - the setup
happens in an `$effect`, and effects do not run on the server.

**A factory with runes, not a Svelte store.** Runes are Svelte 5's reactivity, and they work in
`.svelte.ts` modules as well as in components. A `writable` store would still work, but it would
put `$device` and `subscribe()` in front of every read, and it can be written from outside. Private
`$state` fields behind getters give reactive reads and no writes; the methods are the only way to
change anything.

**The lifecycle is an `$effect` inside `createSerialBroker()`.** The configuration is set up when
the component mounts, and the effect's cleanup runs when it is destroyed - the Svelte 5 way to tie
a resource to a component, with no `onMount`/`onDestroy` pair for the caller to remember. The
setup runs `untrack`ed, because it reads state, and an effect tracking that state would destroy
and set up the connection on every status change. The cost is that the factory has to be called
while a component initialises; `$effect.root()` covers the rest.

**Destroying the component releases the configuration, by default.** Svelte components come and
go while the page stays - a route, a dialog, an `{#if}` block - and a configuration nobody shows any
more would keep the port open, or keep a place in the queue, for nothing. The OpenUI5 example
decides the other way, because there the model lives as long as the application. Where other code
in the tab uses the same configuration, `releaseOnDestroy: false` keeps it.

**A connection releases only what it set up.** A configuration name is one configuration for the
whole tab. A connection whose `setup()` failed - a dialog asking for another baud rate under a name
the page already uses, which is a `CONFIGURATION_CONFLICT` - or that was destroyed before its setup
began, has set nothing up, and its `release()`, `restart()` and destroy leave the configuration
alone. Otherwise closing the dialog would end the page's working connection. A `released` status
from any source ends the ownership too. Two connections that both set up the same name with the
same options do both own it, and the first one destroyed ends it for the other; that case is what
`releaseOnDestroy: false` is for.

**A setup waits for a release of the same name still under way.** A component destroyed and
created again at once - a `{#key}` block, hot module replacement while developing - releases and
sets up in the same moment. The release resolves once the port is closed, and the module keeps it
in a map by name so the new setup waits for it rather than race it.

**Setups, restarts and releases of one connection run one after the other.** `restart()` waits for
the first setup and for an earlier restart, `release()` for both, and destroy for both before it
decides whether there is anything to release. Two setups side by side would both subscribe, and
every event would be shown and counted twice. The listeners are also always removed before new ones
are added, and a `subscribe()` that fails - the configuration released by other code between setup
and subscribe - becomes `failed` with its error rather than an unhandled rejection.

**Options are passed on as a plain copy.** `$state.snapshot()` turns a `$state` proxy - options
built from a form, say - into an object the library can hand between tabs; a proxy cannot be
cloned into a `postMessage`.

**Failures land in `error`, not in rejections.** `connect()` resolves `'granted'`, `'dismissed'` or
`'failed'`, and `send()` resolves `true` or `false`. A click handler has nowhere to put a rejection,
and a view already shows `error`. Anything thrown that is not a `SerialBrokerError` is a bug in the
application and is rethrown, so it stays loud.

**A retryable error is cleared once the port is open; any other stays.** `isRetryable` announces a
recovery, and `open` is that recovery done. A write that timed out or a configuration conflict is
still worth reading after the port reopens, until the user dismisses it or starts over.

**`canSend` means `open`.** The library accepts a write in any status and holds it for the port up
to `connection.writeTimeoutMs`, then rejects with `WRITE_TIMEOUT`. With the status shown next to
the button, a disabled button says the same thing sooner, as in the minimal example.

**`restart()` sets up again, and releases only where that cannot help.** A `failed` configuration is
still set up, and `setup()` with the same options starts it again, from any tab. What this connection
set up is released first in two cases: the tab withdrew with `CONFIGURATION_CONFLICT` because the tab
holding the port runs another `maxTabs`, or the options changed so that they open the port
differently, which `setup()` refuses for a name that is set up.

**`configure()` and `dispose()` live in `main.ts`, not in the module.** Both are page-wide: the
worker URL has to be named once, before the first setup, and `pagehide` fires for a closing tab,
where Svelte destroys no components. A module that did either would do it once per connection.

**A page restored from the back/forward cache is loaded again.** `dispose()` on `pagehide` ends
the library's client, and Chromium keeps a page using Web Locks, a `BroadcastChannel` or Web
Serial out of the cache. Should a browser restore the page anyway - `pageshow` with `persisted`
set - reloading is the one step that cannot leave a stale `open` on an operator's screen; setting up
every connection again would work too, but it would take code in each component.

**The status sentences are in the application, not in the module.** They are words for the
application's users, and a team replaces them. `status-text.ts` types them as a `Record` over the
status union, so a status a later version adds fails the type-check instead of showing a blank.

**`failed` promises no recovery by itself, except after `RECONNECT_EXHAUSTED`.** A `failed` also
follows a setup that failed and a `CONFIGURATION_CONFLICT`, where plugging the device in again
changes nothing. So the sentence points to the error and to _Set up again_, and only the error code
`RECONNECT_EXHAUSTED` - the attempts ran out - selects the sentence saying the device coming back
resumes the connection. That holds with the default `connection.autoReconnect: true`; with `false`,
nothing is retried after `failed`, not even on replug, until `setup()` is called again.

**_Set up again_ appears in `released` and `failed` only.** Those are the two statuses that end.
Before the first setup has finished the status is `idle` and the button is absent, so a click
cannot start over a setup still under way.

**Buttons that do not apply are not rendered; _Send_ is disabled.** A missing button says the step
does not apply; a disabled one suggests a state the user could reach. _Send_ is the exception,
because the input next to it stays useful while the port reopens.

**`remember: false`.** The component sets the configuration up on every load itself, so remembering
it would add nothing and leave an entry in `localStorage` behind. An application whose users
configure devices keeps the default and calls `SerialBroker.restore()`.

**`device: { any: true }`.** The example runs with whatever adapter is at hand, and the stand-in's
loopback matches it. An application names its device by USB ids; the comment at the option says
how.

**The worker URL is named through Vite's `?url` import.** Vite would find the script without it,
through the library's own `new URL(..., import.meta.url)`; naming it makes the URL visible in one
place and is the line to change for another toolchain.

**The stand-in is imported behind `import.meta.env.DEV`.** `?stand-in` lets a reader see every
state without hardware; the dynamic, guarded import keeps it out of the production build.

**No `svelte.config.js`.** Svelte 5 understands TypeScript in `<script lang="ts">` itself, so no
preprocessor is needed. The Vite plugin says so with one line on the terminal - _no Svelte config
found_ - which is not the browser console.

**`svelte-check --fail-on-warnings` is the type-check.** `tsc` cannot read `.svelte` files;
`svelte-check` checks them and the `.ts` files with the same `tsconfig.json`, and treats Svelte's
own warnings - accessibility, unused CSS - as failures. `smoke.spec.ts` is not in that
configuration: the root type-checks it, as [examples/README.md](../README.md) describes.

**The root's Prettier leaves the `.svelte` files alone.** The root has no Svelte plugin for
Prettier, and adding one to the library's dependencies for one example would put a framework into
its toolchain. The `.ts`, `.json` and `.md` files are formatted as everywhere else.

**The smoke test fails on console noise.** Every page error, console error and console warning of
every tab is collected and expected to be empty. The empty `<link rel="icon">` keeps the browser's
request for `/favicon.ico`, and its 404, out of that list.

## Files

```
examples/svelte/
├── example.json                    port 8157, start command, ready path - read by the root
├── index.html                      the page shell, one mount point
├── vite.config.ts                  the Svelte plugin
├── tsconfig.json                   type-check only, for svelte-check
├── smoke.spec.ts                   Playwright: connect, echo, unplug, click to connect, two tabs
└── src/
    ├── main.ts                     configure({ workerUrl }), dispose on pagehide, mount
    ├── App.svelte                  the application: status, error, send, received
    ├── status-text.ts              one sentence per status
    └── lib/
        └── serial-broker.svelte.ts THE REUSABLE MODULE: createSerialBroker()
```
