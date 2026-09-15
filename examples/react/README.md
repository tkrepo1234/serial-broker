# serial-broker in React

A React 19 application that talks to a serial device through [serial-broker](../../README.md), and
the reusable integration it uses: [`src/lib/serial-broker-react/`](src/lib/serial-broker-react), a
`useSerialBroker` hook on a small store. Vite and TypeScript, no other dependency. Copy that folder
into your own React application, or publish it as a package of your own - both are described below.

```tsx
import { useSerialBroker } from './lib/serial-broker-react';

// Declared once, outside the components: the same options in every tab and every render.
const OPTIONS = {
  device: { any: true }, // or { vendorId: 0x1a86, productId: 0x7523 } for one kind of device
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
};

function Device() {
  const { status, lastError, lines, connect, send } = useSerialBroker('Device', OPTIONS);
  return (
    <>
      <code>{status}</code>
      {status === 'awaiting-permission' && (
        // connect() first in the click handler: the browser shows its port picker only during a click.
        <button onClick={() => void connect()}>Connect…</button>
      )}
      {lastError && (
        <p>
          {lastError.code}: {lastError.remediation}
        </p>
      )}
      <ol>
        {lines.map((line) => (
          <li key={line.id}>{line.text}</li>
        ))}
      </ol>
      <button disabled={status !== 'open'} onClick={() => void send('STATUS?\r\n')}>
        Ask
      </button>
    </>
  );
}
```

Open the page in two tabs: both show the same status, both receive, both can send. One of them
holds the port; close it, and the other takes over. Nothing in the application refers to tabs.

## What it shows

- **Every status, named and explained.** `idle`, `queued`, `awaiting-permission`, `connecting`,
  `open`, `reconnecting`, `failed` and `released` each have a label and a one-sentence hint
  ([`src/status.ts`](src/status.ts)). A status the application does not know is shown as it is: the
  set may grow.
- **Two components, one device, no props.** The header badge and the device panel both call
  `useSerialBroker('Device', …)`. They share one store, so they always agree, and a release in one is
  a release in the other.
- **The connect button only where a click is needed.** It appears with `awaiting-permission` and
  calls `connect()` as the first thing in its handler. Later visits open the port with no click.
- **Errors with code, message, time and remediation**, from `onError` and from the hook's own calls.
  A retryable error - one the library is already recovering from - is a note, and clears itself
  when the port is open again. Any other error stays until it is dismissed.
- **Received lines.** Received text is assembled into lines at CR, LF or CR LF, also when a CR LF
  is cut between two `onReceive` events. An answer usually arrives as one event, but event
  boundaries carry no meaning. A line the device has not ended yet - a prompt - is shown greyed. The last 500
  lines are kept.
- **Sending**, enabled only while the port is open, with CR LF appended by the application.
- **Release and use again.** _Release the device_ gives it up in this tab only; the other tabs keep
  it. _Use the device again_ sets it up anew, also to start over from `failed`.
- **StrictMode is on.** Every effect runs twice in development, and the hook subscribes exactly once
  regardless: the smoke test checks that an echoed line appears once, not twice.

## Running it

The application uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/react
npm install
npm start          # serves http://localhost:8155/
```

| Command             | What it does                                                      |
| ------------------- | ----------------------------------------------------------------- |
| `npm start`         | Serves the application at <http://localhost:8155/> with Vite.     |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `vite.config.ts`.                  |
| `npm run build`     | Type-checks, then a production build in `dist/`, worker included. |
| `npm run preview`   | Serves that build on the same port.                               |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. Without a device the status is `awaiting-permission`, and _Connect…_ opens the
browser's port picker. Without any hardware, open <http://localhost:8155/?stand-in>: the
repository's loopback stand-in replaces Web Serial and echoes every line you send (development
server only).

### The smoke test

[`smoke.spec.ts`](smoke.spec.ts) drives the application in the installed Edge with the Web Serial
stand-in in place of a device. It clicks _Connect…_, sees `open` in the panel and in the header,
sends `PING` and sees exactly one echoed line, opens a second tab that sends `PONG` and sees it in
both, unplugs and plugs the device and sees the note come and go, releases the device in the first
tab while the second keeps it, and uses it again. It fails on any page error and on any console
warning or error. It runs through the repository root, which starts the application first:

```sh
# in the repository root, after `npm run build` there and `npm install` here
npm run test:examples -- examples/react/smoke.spec.ts
```

The test itself is type-checked by the root, not by this folder: it is in the root's TypeScript
program, and like the rest of the folder it is not linted, as [examples/README.md](../README.md)
describes.

## Taking the hook into your own application

1. **Install the library:** `npm install serial-broker`. React 18 or later is required, for
   `useSyncExternalStore`.
2. **Copy `src/lib/serial-broker-react/`** into your application. Three files, no JSX, no
   dependencies beyond `react` and `serial-broker`.
3. **Configure the worker URL once, before the first render**, in your entry module - as
   [`src/main.tsx`](src/main.tsx) does:

   ```tsx
   import { SerialBroker } from 'serial-broker';
   import workerUrl from 'serial-broker/worker?url';

   SerialBroker.configure({ workerUrl });
   createRoot(root).render(<App />);
   ```

   Tabs coordinate through a `SharedWorker`, identified by the URL of its script, so every tab has to
   load the same file from your origin. Vite serves it through the `?url` import and copies it into
   the build. With another toolchain, copy `node_modules/serial-broker/dist/serial-broker.worker.js`
   to your static files and pass that path; [Installing](../../docs/site/installing.md#the-worker-script)
   has the details.

4. **Declare the options outside the component**, one constant per device. Name the device by its USB
   ids (`device: { vendorId: 0x0403, productId: 0x6001 }`) and give its baud rate; pass
   `encoding: { decodeText: true }` to get text lines. Leaving `device` out lets the port the user
   picks decide.
5. **Call `useSerialBroker(name, options)`** in every component that needs the device. No provider is
   needed.
6. **Offer _Connect_ only for `awaiting-permission`**, and call `connect()` first thing in the click
   handler, with no `await` before it.
7. **Render `lastError.code` and `lastError.remediation`**, show a retryable error as a note, and
   branch on `code` where the application has to decide - never on `message`. `OWNER_LOST_DURING_WRITE`
   is the one that needs a decision: the device may or may not have received the write
   ([Guarantees](../../docs/site/guarantees.md)).
8. **Leave `?stand-in` and `src/stand-in.ts` behind.** They reach into this repository's test support.

### What the hook returns

| Field            | Meaning                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `status`         | The library's status, unchanged: `idle` until set up, `failed` if `setup()` itself failed.    |
| `lastError`      | The most recent `SerialBrokerError`, or `null`.                                               |
| `lines`          | `{ id, text, timestamp, complete }[]`, oldest first; `id` is a stable React key.              |
| `connect()`      | Shows the port picker. Resolves `true` once a device is available.                            |
| `send(data)`     | Sends text or bytes, nothing appended. Resolves `true` once the browser took the bytes.       |
| `release()`      | Stops using the device in this tab. Stays released - across remounts too - until `restart()`. |
| `restart()`      | Sets the configuration up again, with the options of the latest render.                       |
| `dismissError()` | Clears `lastError`.                                                                           |

None of the actions rejects: a failure resolves `false` (or nothing) and lands in `lastError`, so a
click handler can `void` them. The hook's third argument sets `maxLines` (500) and `maxLineLength`
(1000), the length at which a line the device never ends is cut. Without `decodeText`, bytes arrive
as `1A 2B ` and carry no line ending, so every line is cut - at whole bytes, 333 of them by default.

### Turning the hook into a package of your own

When several applications of a team talk to devices, publish the folder once instead of copying it:

1. **Make it a package.** Move the three files into `src/` of a new package, next to this
   `package.json`:

   ```json
   {
     "name": "@your-team/serial-broker-react",
     "version": "1.0.0",
     "type": "module",
     "sideEffects": false,
     "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
     "files": ["dist"],
     "scripts": { "build": "tsc -p tsconfig.build.json" },
     "peerDependencies": { "react": ">=18", "serial-broker": "^0.1.0-alpha.1" },
     "devDependencies": {
       "@types/react": "^19",
       "react": "^19",
       "serial-broker": "^0.1.0-alpha.1",
       "typescript": "^6"
     }
   }
   ```

2. **Keep `react` and `serial-broker` peer dependencies**, never dependencies. `SerialBroker` is one
   instance per copy of the library: if your package brought its own copy, the application and the
   package would run two clients in one tab, each setting up the same name. A peer dependency makes
   the application's copy the only one.
3. **Build with `tsc` alone.** The files contain no JSX, so a `tsconfig.build.json` with
   `"declaration": true`, `"outDir": "dist"`, `"rootDir": "src"` and `"module": "ESNext"` emits
   JavaScript and type declarations the way they are; the relative imports already end in `.js`.
   Checked against this folder: it compiles as it is.
4. **Leave the worker URL to the application.** A package cannot serve a file from the application's
   origin. Its README tells the application to call `SerialBroker.configure({ workerUrl })` before
   the first render, as step 3 above.
5. **Publish to your registry**, or reference it from a workspace (`"@your-team/serial-broker-react":
"workspace:*"`), and import `useSerialBroker` from the package name.
6. **Pin the range of `serial-broker` you have tested.** The library is pre-release: a minor version
   may change the API until 1.0.

## What a developer needs to know

**One store per configuration name, per tab.** `useSerialBroker()` looks the store up by name. The
first component to subscribe sets the configuration up; the last one to unmount stops listening.
Unmounting never releases the device - a closing tab releases it anyway, and a route change should
not disconnect a device the rest of the application watches.

**The options are read once.** The library sets a name up with one set of options per tab; other
options under the same name are `CONFIGURATION_CONFLICT`. So the hook reads them when the name is
first used, and again on `restart()` - a changed object on a later render does nothing by itself.

**StrictMode and hot updates pair up by construction.** React's `useSyncExternalStore` subscribes
after the commit and unsubscribes on unmount - twice in a row under StrictMode. The store counts
subscribers, and a `setup()` that resolves after its subscriber left does not subscribe to the
library. `setup()` itself leaves a working configuration alone when called again with the same
options. Tried in the browser
with `?stand-in`: after a hot update of `App.tsx` the lines stayed and the next echo appeared once;
after an edit of `connection.ts` the page came back `open` with an empty list - the store module is
replaced - and the next echo appeared once. Neither logged a warning.

**`configure()` belongs in the entry module.** It has to run before the first `setup()`, and only
once: called later, the library logs `facade.late-configure`. In `main.tsx` it runs once per page
load; a hot update of a component does not run it again.

**One tab holds the port; no tab can tell which.** Do not write UI that claims "this tab owns the
device". In a tab that knows another tab holds the port, the library refuses to show the port
picker with `PERMISSION_REQUIRED`, unless the status is `open`; `connect()` puts that error in
`lastError`, and its remediation says what to do.

**Lines start when someone looks.** When the last component unmounts, the store forgets the lines:
kept, they would have a gap nobody could see.

## Stable element ids

| Element                                  | Id                  |
| ---------------------------------------- | ------------------- |
| Status, the raw value                    | `status`            |
| Status hint, one sentence                | `status-hint`       |
| Status label in the header               | `header-status`     |
| Connect button                           | `connect`           |
| Release button                           | `release`           |
| Use the device again                     | `restart`           |
| Error box (absent if none)               | `error`             |
| Error code                               | `error-code`        |
| Error message                            | `error-message`     |
| Error remediation                        | `error-remediation` |
| Dismiss the error                        | `error-dismiss`     |
| Received lines (`<ol>`, one `<li>` each) | `received`          |
| Send form                                | `send-form`         |
| Send input                               | `send-input`        |
| Send button                              | `send-button`       |

`#status` and `#header-status` carry `data-tone` for styling, `#error` carries `data-retryable`, and
each received `<li>` carries `data-complete`. Buttons that do not apply to the current status are not
rendered at all, rather than hidden.

## Design decisions

**A store with `useSyncExternalStore`, not `useEffect` and `useState` in the hook.** The obvious
hook - subscribe in an effect, copy events into state - gives every component its own copy. Two
components using the same device then disagree after a release in one of them, and each holds its
own subscriptions. `useSyncExternalStore` is React's API for exactly this: one external source, any
number of components, subscribe and unsubscribe paired by React, and no torn renders under
concurrent rendering.

**The store knows nothing about React.** [`connection.ts`](src/lib/serial-broker-react/connection.ts)
imports only `serial-broker`; the hook is a few lines of code on top. The part with the subtle ordering -
generations, release, restart, line assembly - can be read, and tested, without a renderer, and would
serve a Preact or a plain-DOM widget unchanged.

**A generation counter instead of an "is mounted" flag.** StrictMode subscribes, unsubscribes and
subscribes again before the first `setup()` has resolved. Every start, stop, release and restart
bumps the counter, and a `setup()` that resolves for an older generation is ignored. Removing that
check makes the smoke test fail with the echoed line shown twice - it was tried.

**Unmounting does not release; a release stays until `restart()`.** Releasing on unmount would
disconnect the device on every route change, and StrictMode would release it on the first mount.
And a release is an operator's decision: a component that mounts again must not take the device back
by itself.

**The actions resolve, and never reject.** A click handler has nowhere to put a rejection, and an
unhandled one is console noise. Failures go to `lastError`, where the error box renders them;
`send()` resolves `false` so a caller can keep the input for another try.

**Retryable errors clear themselves on `open`; others stay.** `DEVICE_DISCONNECTED` is explained by
the reconnect that follows it. `RECONNECT_EXHAUSTED` or `OWNER_LOST_DURING_WRITE` happened even if the
port is open again, and an operator who looks later should still see it - until dismissed.

**A failed `setup()` shows as `failed`.** Nothing is registered then, so the library has no status
to report. `idle` forever next to an error would be a lie; `failed` with `WEB_SERIAL_UNAVAILABLE` and
its remediation is what the user needs.

**Received lines only, not sent ones.** The list is what the device said. `onSend` is left out, so
an echo in the list is an echo, and the smoke test's line count means something.

**No batching of renders per animation frame.** Every `onReceive` event renders once. For scales,
scanners and controllers that answer commands, that is nothing. For a device that streams many
events a second, batch the store's notifications per frame - a change in `#update()` alone.

**The worker URL through Vite's `?url` import, in `main.tsx`.** Vite would find the script without
it, through the library's `new URL(..., import.meta.url)`. Naming it makes the URL visible in one
place and is the line to change for another toolchain. It sits in the entry module, not in the hook's
module, so a hot update never calls `configure()` a second time.

**No `server.fs.allow` in `vite.config.ts`.** The library is linked from two directories up, outside
this project, which looked as if it would need one. Measured: Vite serves the linked worker script
without it, and serves `test/browser/stand-in/` once `src/stand-in.ts` has imported it - which is
the only way the page reaches it. Fetched directly, before that import, the stand-in answers 403.

**`?stand-in` only in development.** `import.meta.env.DEV` guards it, so `vite build` leaves the
stand-in out of the bundle.

**StrictMode stays on.** It is what an application generated by today's templates runs with, and
the example has to prove the hook survives it.

**The smoke test starts with an ungranted device**, so the application's own connect path runs,
with a real click. A second tab, an unplugged device and a release follow, because those are what
make serial-broker different from `navigator.serial` - and where a hook would go wrong.

**React 19.3, `@vitejs/plugin-react` 6, TypeScript 6.** Plugin-react 6 transforms JSX with Oxc and
needs no Babel. TypeScript stays on the 6 line the other examples and the root use, although npm's
latest is 7.

**React's file naming, not the root's.** `useSerialBroker.ts` and `App.tsx`, as a React team expects;
the root's guidelines govern `smoke.spec.ts` only.

**The root ESLint configuration ignores this folder, the smoke test included**, as for every
example; `npm run typecheck` is the gate here. In your own application, add `eslint-plugin-react-hooks`: the
hook is written to pass its rules.

**`"type": "module"` in `package.json`.** Playwright reads `smoke.spec.ts` according to the nearest
`package.json`, and `import.meta.url`, which finds `example.json`, needs ES modules.

## Files

```
examples/react/
├── example.json          port 8155, start command, ready path - read by the root's test runner
├── smoke.spec.ts         Playwright: connect, echo once, second tab, unplug, release, use again
├── index.html            the page shell and #root
├── vite.config.ts        React plugin, port
├── tsconfig.json         type-check only
├── package.json          react, react-dom, vite, typescript, "serial-broker": "file:../.."
└── src/
    ├── main.tsx          ?stand-in, configure({ workerUrl }), render in StrictMode
    ├── App.tsx           header and device panel, both on useSerialBroker()
    ├── status.ts         label, tone and hint for every status
    ├── styles.css
    ├── stand-in.ts       the loopback stand-in for ?stand-in - leave it behind
    └── lib/serial-broker-react/     THE REUSABLE PART
        ├── connection.ts            the store: setup, subscriptions, lines, release, restart
        ├── useSerialBroker.ts       the hook: useSyncExternalStore on the store
        └── index.ts                 what a package would export
```
