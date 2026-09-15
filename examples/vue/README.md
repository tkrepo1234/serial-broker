# serial-broker in a Vue 3 application

A runnable Vue 3 application that talks to a serial device through
[serial-broker](../../README.md), and the reusable composable it uses:
[`src/serial-broker/useSerialBroker.ts`](src/serial-broker/useSerialBroker.ts). Copy that one file
into your own Vue project and a device is a set of refs you read in a template:

```vue
<script setup lang="ts">
import { useSerialBroker } from './serial-broker/useSerialBroker';

const { status, lastError, lines, canSend, connect, send, release } = useSerialBroker('Scale', {
  device: { vendorId: 0x0403, productId: 0x6001 },
  serial: { baudRate: 19_200 },
  encoding: { decodeText: true },
});
</script>

<template>
  <p>Status: {{ status }}</p>
  <!-- The one step that needs a click: connect() calls requestAccess() synchronously. -->
  <button v-if="status === 'awaiting-permission'" @click="connect">Connect…</button>
  <p v-if="lastError">{{ lastError.code }}: {{ lastError.remediation }}</p>
  <ol>
    <li v-for="line in lines" :key="line.id">{{ line.text }}</li>
  </ol>
  <button :disabled="!canSend" @click="send('TARE\r\n')">Tare</button>
</template>
```

Vite, TypeScript, `<script setup>`, no router and no store. Open the page in two tabs: both show the
same status, both receive, both can send. One of them holds the port; close it, and the other takes
over. Nothing in the code refers to tabs.

## What it shows

- **Every status, named and explained.** `idle`, `queued`, `awaiting-permission`, `connecting`,
  `open`, `reconnecting`, `failed` and `released` each have one sentence for the person at the
  screen, and a colour by meaning: open, on its way, needs you, stopped. Connecting, reconnecting
  and queued pulse, because the page is waiting, not stuck. A status the page does not know is shown
  as it is, in the neutral colour: the set may grow.
- **The connect button only where a click is needed.** _Connect…_ appears with
  `awaiting-permission` and nowhere else. Later visits open the port with no click, because the
  browser remembers the choice. Closing the picker without choosing says so under the button.
- **Errors with code, message and remediation**, from `onError` and from the calls the page makes.
  A retryable error, one the library is already recovering from, is shown as a note with an amber
  border, not as a problem. The panel clears when the port is open again, and has _Dismiss_.
- **Traffic in lines.** Received chunks are assembled into lines at the device's line endings; sent
  lines are listed from `onSend`, marked as sent from this tab or from another one. A line the
  device has started but not finished is shown under the list. The list keeps the last 500 lines.
- **Sending with a chosen line ending**, CR LF by default, enabled only while the port is open.
- **Release, and the way back.** _Release in this tab_ gives the device up here; the other tabs keep
  it. _Set up again_ after `released`, and _Try again_ after `failed`, start over.
- **Nothing on the console.** The library logs nothing unless given a logger, and the page does not
  either; the smoke test fails on any console warning or error.

## Running it

The application uses the library from the repository it lives in, so build that once:

```sh
# in the repository root
npm ci
npm run build
```

Then:

```sh
cd examples/vue
npm install
npm start          # serves http://localhost:8156/
```

| Command             | What it does                                                               |
| ------------------- | -------------------------------------------------------------------------- |
| `npm start`         | Serves the application at <http://localhost:8156/> with Vite's dev server. |
| `npm run typecheck` | `vue-tsc --noEmit` over `src/`, the `.vue` files included.                 |
| `npm run build`     | Type-checks, then builds `dist/`: one page, one script, the worker script. |
| `npm run preview`   | Serves that build on the same port.                                        |

Chrome or Edge is required - Web Serial exists nowhere else - and a secure context, which
`localhost` counts as. Without a device you still see the application: the status is
`awaiting-permission`, and _Connect…_ opens the browser's port picker. A USB-serial adapter with its
TX and RX pins bridged echoes every line you send.

**Without any hardware**, open <http://localhost:8156/?stand-in>: the page installs the
repository's Web Serial stand-in, a granted loopback device, before the library starts. In the
browser console, `webSerialStandIn.unplug()` and `webSerialStandIn.plug()` show `reconnecting` and
the way back.

The smoke test runs the application against the same stand-in, from the repository root:

```sh
npm run test:examples -- examples/vue/smoke.spec.ts
```

## Taking the composable into your own application

1. **Install the library:** `npm install serial-broker`.
2. **Copy [`src/serial-broker/useSerialBroker.ts`](src/serial-broker/useSerialBroker.ts)** into your
   project. One file; it imports `vue` and `serial-broker` and nothing else.
3. **Serve the worker script from your origin, and name it once, before `createApp()`**, as
   [`src/main.ts`](src/main.ts) does:

   ```ts
   import { SerialBroker } from 'serial-broker';
   import workerUrl from 'serial-broker/worker?url';

   SerialBroker.configure({ workerUrl });
   createApp(App).mount('#app');
   ```

   Tabs coordinate through a `SharedWorker`, which is identified by the URL of its script, so every
   tab must load the same file from your origin. With Vite the `?url` import does that, in
   development and in the build. With another toolchain, copy
   `node_modules/serial-broker/dist/serial-broker.worker.js` to your static files and pass that path.

4. **Call `useSerialBroker(name, options)`** in the component that shows the device. `name` is the
   same in every tab; `options` go to `SerialBroker.setup()` unchanged. Replace
   `device: { any: true }` with the device's USB ids and `baudRate` with its rate. On Windows the ids
   are in Device Manager under _Hardware Ids_ (`VID_1A86&PID_7523`).
5. **Show a connect button only for `awaiting-permission`**, and call `connect()` first thing in
   its click handler, with no `await` before it.
6. **Show `lastError.code` and `lastError.remediation`**, and branch on `code` where the application
   has to decide - never on `message`. A `send()` that resolves `false` has put its error there.
7. **Decide what `OWNER_LOST_DURING_WRITE` means for your commands.** When the tab holding the port
   closes in the middle of a write, nobody can tell whether the device got it, and the library does
   not send it again. Only the application knows whether a command may run twice:

   ```ts
   if (!(await send('DISPENSE 1\r\n')) && lastError.value?.code === 'OWNER_LOST_DURING_WRITE') {
     // Not repeated: a second dispense is worse than none. Ask the operator instead.
   }
   ```

### What the composable returns

| Name                | Type                                       | Meaning                                                                                  |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `status`            | `Readonly<Ref<SerialBrokerStatus>>`        | The library's status, unchanged. Starts at `idle`. Treat the set of values as growing.   |
| `isSetUp`           | `Readonly<Ref<boolean>>`                   | The configuration is set up in this tab: after `setup()`, until `released`.              |
| `canSend`           | `ComputedRef<boolean>`                     | `status === 'open'`.                                                                     |
| `lastError`         | `Readonly<Ref<SerialBrokerError \| null>>` | The latest error, with `code`, `message`, `remediation`, `isRetryable`. Cleared on open. |
| `lines`             | `Readonly<Ref<readonly SerialLine[]>>`     | Received and sent lines, newest last, capped at `maxLines`.                              |
| `partialLine`       | `Readonly<Ref<string>>`                    | Received text after the last line ending.                                                |
| `connect()`         | `Promise<boolean>`                         | Shows the port picker. `false` when the user closed it, or when it failed.               |
| `send(data)`        | `Promise<boolean>`                         | Writes text or bytes, as they are. `false` when the write failed.                        |
| `release(options?)` | `Promise<void>`                            | Stops using the device in this tab. `{ forgetDevice: true }` revokes the permission.     |
| `restart()`         | `Promise<void>`                            | Sets the configuration up again, after `released` or `failed`.                           |
| `clearLines()`      | `void`                                     | Empties `lines` and `partialLine`.                                                       |
| `clearError()`      | `void`                                     | Sets `lastError` to `null`.                                                              |

The third argument takes `maxLines` (default 500) and `releaseOnDispose` (default `false`).

Several components may call `useSerialBroker()` with the same name. They follow one configuration:
a `release()` in one shows `released` in all of them, and a `restart()` in one brings all of them
back.

## What a developer needs to know

**`connect()` needs a user gesture.** The browser shows its port picker only during the transient
activation of a click, and any `await` before `requestAccess()` uses it up; the call then fails with
`USER_GESTURE_REQUIRED`. `connect()` calls it synchronously, so call `connect()` from the click
handler and nothing else before it.

**The worker script must come from your origin, under one URL.** Two tabs that load it from
different URLs get two workers and share nothing - they compete for the device.

**One tab holds the port; no tab can tell which.** Every tab sets the configuration up, receives the
same events and can send. Do not write UI that claims "this tab owns the device".

**Lifecycle.** The composable unsubscribes when its effect scope ends - for `<script setup>`, when
the component is unmounted. It does not release the configuration then unless `releaseOnDispose` is
set, and even then not while another composable of the same tab still uses the name: a closing tab
releases its share anyway. Vue warns in development when the composable is called outside a component or an
`effectScope()`, where nothing would ever unsubscribe.

## Stable element ids

| Element                                                                                                             | Id                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Status, the raw value (`data-status` raw, `data-tone` its meaning)                                                  | `status`                                                |
| Status hint, one sentence                                                                                           | `status-hint`                                           |
| Connect button (`awaiting-permission` only)                                                                         | `connect`                                               |
| Note after the picker was closed                                                                                    | `connect-note`                                          |
| Try again (`failed` only), Set up again (`released` only)                                                           | `retry`, `setup-again`                                  |
| Release in this tab (while set up)                                                                                  | `release`                                               |
| Open another tab                                                                                                    | `open-tab`                                              |
| Error panel (absent if none; `data-retryable`)                                                                      | `error`                                                 |
| Error code, message, remediation                                                                                    | `error-code`, `error-message`, `error-remediation`      |
| Retryable note, dismiss                                                                                             | `error-retryable`, `error-dismiss`                      |
| Traffic list (`li[data-direction]`: `received`, `sent`; `li[data-kind]`: `received`, `sent-here`, `sent-elsewhere`) | `received`                                              |
| Unfinished received line                                                                                            | `received-partial`                                      |
| Clear the list                                                                                                      | `clear-received`                                        |
| Send form, input, line ending, button                                                                               | `send-form`, `send-input`, `line-ending`, `send-button` |

Elements shown with `v-if` are absent from the DOM while hidden, not merely invisible: a test
expects `toHaveCount(0)` for them.

## Design decisions

**One file for the integration, with no dependency on the application.** The status sentences, the
components and the styling are the application's; the composable returns the library's own values -
the status union unchanged, a real `SerialBrokerError` - so a team adds its own presentation without
changing the file it copied.

**`name` and `options` are read once, not watched.** A configuration that changes its device or its
line settings while the port is open in another tab is a `CONFIGURATION_CONFLICT`, not a
reconfiguration. A different device is a different name, and a different component instance.

**Actions resolve, they do not reject; the error goes to `lastError`.** A template handler has
nowhere to put a rejection, and an unhandled one would be console noise. `send()` and `connect()`
resolve `false` on failure; the error is set before they resolve, so code that has to decide -
above all for `OWNER_LOST_DURING_WRITE` - reads `lastError.value.code` right after the `false`.

**`lastError` holds the `SerialBrokerError` itself**, not a copy of some fields. A template reads
`code`, `message`, `remediation` and `isRetryable` directly, and code that needs `context` or
`toJSON()` for a support log has them. Anything that is not a `SerialBrokerError` is wrapped under
`UNKNOWN` with the original as `cause`, so there is one shape to show.

**Shallow refs for `lastError` and `lines`.** Both are replaced, never changed in place. A deep ref
would make every field of every line reactive, for each chunk a device sends; a shallow one costs a
single change per chunk.

**Lines are assembled in the composable.** serial-broker does no framing: a chunk is an arbitrary
piece of the byte stream. Nearly every industrial device talks in lines, so the composable splits
at CR LF, LF or CR, holds a CR at the end of a chunk back for a LF in the next one, and keeps the
unfinished rest in `partialLine`. A rest longer than 4096 characters becomes a line of its own, so a
device that never sends a line ending cannot grow memory without end. Without `decodeText`, each
chunk is listed as hexadecimal.

**Not released when the component unmounts, unless asked.** Releasing on unmount would add a release
and a set-up, and an interrupted port, for every route change. A closing tab releases its share
anyway. `releaseOnDispose: true` is for a component that owns a device for a while, such as a dialog
for a one-off scan.

**Composables of one name follow one configuration.** The library keeps one configuration per name
in a tab, so a release by one composable is a release for every composable of that name. Left to
themselves, the others would show `released`, with _Set up again_, next to a port that another
composable's `restart()` had just opened - on a production screen, a device that looks disconnected
and is not. So the composables of a tab know each other, by name, in the one file: a set-up after a
release brings every composable that followed the released configuration back, with its error
cleared. One whose own `setup()` failed, with `CONFIGURATION_CONFLICT` say, stays `failed`: the
configuration that exists is not the one it asked for. For the same reason `releaseOnDispose`
releases only when the last composable of the name goes, and checks that after the current
`setup()` has settled: a component re-created in the same tick, by a changed `:key` or hot module
replacement, keeps the device rather than losing it under the new instance.

**A composable never ends up with nothing to press.** If the configuration is released between
`setup()` resolving and the subscriptions - by another composable of the name - `subscribe()` throws
`UNKNOWN_CONFIGURATION`. The composable catches that like a failed set-up: the error is shown, the
status is `failed`, and _Try again_ is there. Nothing rejects unhandled.

**`restart()` sets up again, and releases first only after a withdrawal.** A configuration in
`failed` is still set up, and `setup()` with the same options starts it again, from any tab. A tab
that withdrew with `CONFIGURATION_CONFLICT`, because the tab holding the port runs another `maxTabs`,
does not come back that way, so `restart()` releases it first. The buttons that call it are disabled
while it runs, so a second click cannot release what the first sets up.

**A setup that fails shows `failed`.** Where Web Serial is missing, `setup()` rejects with
`WEB_SERIAL_UNAVAILABLE`, whose remediation names the browsers that work; the page shows it like any
other error, with no `isSupported()` check before it. The library never reported a status for a
configuration it did not register, and `failed` - stopped, the error says why - is what the person
at the screen should see.

**Send is enabled only while the port is open.** The library accepts a write in any status and
waits for the port up to `connection.writeTimeoutMs`. Next to a status that says `reconnecting`, a
button that cannot be pressed says the same thing sooner than a `WRITE_TIMEOUT` five seconds later.

**Buttons are shown with `v-if`, not disabled.** A disabled button suggests a state the user could
reach; an absent one says the step does not apply. Send is the exception, because the input next to
it stays useful.

**`remember: false`.** The page sets the configuration up on every load itself, so remembering it
would add nothing and leave an entry in `localStorage` behind. An application whose devices the user
configures keeps the default and calls `SerialBroker.restore()`.

**`device: { any: true }`.** The example should run with whatever adapter a reader has, and the
stand-in's loopback matches it too. The comment next to it shows how to name a device by USB ids.

**The worker URL is named explicitly, through Vite's `?url` import.** Vite would find the script
without it, from the library's own `new URL(..., import.meta.url)`. Naming it costs two lines, puts
the URL in one place, and is the line to change for another toolchain. In this repository the
library is linked (`file:../..`), and Vite serves it through `/@fs/`; the same two lines cover that.

**`?stand-in` imports the repository's stand-in, in development only.** The import is dynamic and
behind `import.meta.env.DEV`, so the production build leaves it out (verified: `dist/` contains no
trace of it). An application of your own drops that block from `main.ts`.

**`vue-tsc` is the type-check, and `npm run build` runs it first.** Plain `tsc` does not read `.vue`
files, and Vite strips types without checking them. The root ESLint configuration ignores this
folder, as it does every example except its `smoke.spec.ts`; Prettier still formats it.

**`<link rel="icon" href="data:,">`.** Without it the browser requests `/favicon.ico`, the dev
server answers 404, and the console shows an error that is not the application's.

## Files

```
examples/vue/
├── example.json                     port 8156, start command, ready path - read by the root's runner
├── index.html                       the mount point
├── vite.config.ts                   the Vue plugin, the fixed port
├── tsconfig.json                    type-check only, through vue-tsc
├── smoke.spec.ts                    Playwright: granted device opens on load, echo, unplug and plug;
│                                    ungranted device via Connect, release, set up again
└── src/
    ├── main.ts                      configure({ workerUrl }), the optional stand-in, createApp
    ├── App.vue                      <script setup>: status, buttons, send form
    ├── status-presentation.ts       one sentence and a tone per status
    ├── style.css                    plain styling for an operator's screen
    ├── components/
    │   ├── ErrorPanel.vue           code, message, remediation, retryable note
    │   └── TrafficList.vue          received and sent lines, the unfinished line
    └── serial-broker/
        └── useSerialBroker.ts       THE REUSABLE COMPOSABLE
```
