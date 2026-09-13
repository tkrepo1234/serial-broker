# serial-broker

One serial port, every tab.

The [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) gives a
single browsing context exclusive access to a device: open it in one tab and every other tab
gets `InvalidStateError`. This library removes that limit. One tab holds the port; every tab
reads from it and writes to it. When that tab closes, another takes over. When the device is
unplugged or powered off, the connection comes back on its own.

```ts
import { SerialBroker } from 'serial-broker';

await SerialBroker.setup('CardReader', {
  device: { vendorId: 0x1a86, productId: 0x7523 },
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});

SerialBroker.subscribe('CardReader', 'onReceive', (event) => {
  console.log(event.text);
});

await SerialBroker.send('CardReader', 'STATUS?');
```

That is the whole integration. Nothing in it says which tab owns the port, and nothing can:
the coordination is deliberately invisible.

## What it does

| Capability                          | What it means                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Shares one port across tabs**     | Every tab can read and write. Writes from any tab reach the device exactly once.                                            |
| **Survives the owning tab closing** | Including a crash, an out-of-memory kill or a closed laptop — no unload handler required.                                   |
| **Reconnects automatically**        | Device switched off, unplugged, power-cycled: the port reopens with the same settings, with no application code.            |
| **Remembers the device**            | The browser keeps the permission; this library keeps the configuration. A later visit connects with no prompt.              |
| **Sends text and binary**           | Strings are UTF-8 encoded; bytes are passed through untouched. Received data is always bytes, optionally with decoded text. |
| **Reports failures usefully**       | Every error carries a stable code, structured context, and a specific sentence saying what to do about it.                  |

## Requirements

A Chromium-based browser (Chrome, Edge, Opera, Brave) in a **secure context** — HTTPS, or
`localhost` during development. Web Serial is not available in Firefox or Safari.

```ts
if (!SerialBroker.isSupported()) {
  // Offer something else, or say why the device feature is unavailable.
}
```

## Install

```sh
npm install serial-broker
```

The library needs to load one extra file, `serial-broker.worker.js`, which coordinates the
tabs. Bundlers that understand `new URL(..., import.meta.url)` — Vite, webpack 5, Parcel 2,
Rollup — find it on their own. If yours does not, or if you serve assets from a different
origin path, say where it is **before the first `setup()`**:

```ts
SerialBroker.configure({ workerUrl: '/assets/serial-broker.worker.js' });
```

If the worker cannot be loaded at all, the library falls back to a `BroadcastChannel` and
keeps working. You will see it in the logs, not in the behaviour.

## Permission: the one thing the library cannot do for you

A browser only shows the serial port picker during a **user gesture**, and nothing can work
around that. So connecting has two shapes:

**The device was granted on an earlier visit.** `setup()` finds it and opens it immediately.
Nothing else is needed — this is the normal case after the first time.

**The device has never been granted.** `setup()` reports the status
`awaiting-permission` and waits. Call `requestAccess()` from a click handler:

```ts
connectButton.addEventListener('click', async () => {
  const granted = await SerialBroker.requestAccess('CardReader');
  connectButton.hidden = granted;
});
```

Call it synchronously from the handler. Any `await` before it consumes the gesture, and the
browser will refuse.

## API

### `setup(name, options): Promise<void>`

Registers a configuration and starts keeping it connected. Safe to call on every page load:
calling it again with equivalent options does nothing.

```ts
await SerialBroker.setup('Scale', {
  device: { vendorId: 0x0403, productId: 0x6001 }, // USB vendor and product ID, or { any: true }
  serial: {
    baudRate: 19200, // required
    dataBits: 8, // 7 | 8                    default 8
    stopBits: 1, // 1 | 2                    default 1
    parity: 'even', // 'none' | 'even' | 'odd'  default 'none'
    bufferSize: 255, // bytes                    default 255
    flowControl: 'none', // 'none' | 'hardware'      default 'none'
  },
  connection: {
    initialDelayMs: 250, // delay before the second attempt; the first is immediate
    factor: 2, // multiplier per attempt
    maxDelayMs: 30_000, // ceiling
    jitter: 0.5, // full-jitter floor, 0–1
    maxAttempts: Infinity, // then the status becomes 'failed'
    stableAfterMs: 5_000, // how long a connection must hold before the counter resets
    openTimeoutMs: 10_000, // deadline for open() and close()
    writeTimeoutMs: 5_000, // deadline for one send(), including waiting for a connection
    maxWriteChunkBytes: 4096,
  },
  encoding: {
    encoding: 'utf-8', // how received text is decoded; strings are always sent as UTF-8
    decodeText: true, // also deliver `text` on onReceive
  },
  persist: true, // restore this configuration after a reload
});
```

### Devices without USB IDs

`SerialPort.getInfo()` reports vendor and product IDs **only for USB devices**. A built-in
RS-232 interface on an industrial PC, a virtual COM port pair, a Bluetooth serial profile:
none of them report anything to filter on. For those, say so:

```ts
await SerialBroker.setup('PanelPort', {
  device: { any: true },
  serial: { baudRate: 9600 },
});
```

The library then accepts whatever port the user granted, and the picker is shown unfiltered.

The trade-off is real: with more than one such port granted, the library cannot tell them
apart — it uses the first and warns. **Use the USB filter whenever the device has IDs.** See
[ADR-0016](./docs/adr/0016-non-usb-devices.md).

### `send(name, data): Promise<void>`

Sends `string` (UTF-8) or `BufferSource`. **Nothing is appended** — no newline, no terminator.
The promise resolves once the bytes have been handed to the device.

Whichever tab currently owns the port performs the write; the caller does not have to be that
tab and cannot tell whether it is.

### `subscribe(name, event, listener): () => void`

| Event            | Payload                                       | Fires                                                                        |
| ---------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| `onReceive`      | `{ name, data, text?, timestamp }`            | A chunk arrived, in every tab.                                               |
| `onSend`         | `{ name, data, origin, timestamp }`           | Bytes reached the device, in every tab. `origin` is `'local'` or `'remote'`. |
| `onError`        | `{ name, error, timestamp }`                  | Something went wrong.                                                        |
| `onStatusChange` | `{ name, status, previousStatus, timestamp }` | The connection status changed.                                               |

Returns a function that removes the listener. `unsubscribe(name, event, listener)` does the
same for code that keeps its callbacks.

A listener that throws is reported through `onError` and does not prevent the other listeners
from receiving the event.

### `getStatus(name)`

```ts
{
  name, status, vendorId, productId, serialOptions,
  since,          // when the current status was entered
  observedAt,     // when this snapshot was taken
  lastErrorCode,  // the most recent error, or undefined
}
```

| Status                | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `idle`                | Registered, not yet connecting.                                      |
| `awaiting-permission` | No granted device matches. Call `requestAccess()` from a gesture.    |
| `connecting`          | Opening a port.                                                      |
| `open`                | Ready. Data can be sent and will be received.                        |
| `reconnecting`        | The connection was lost; it is being re-established.                 |
| `failed`              | Reconnection gave up. Revives automatically if the device reappears. |
| `released`            | The configuration was released in this tab.                          |

Treat the list as extensible: handle an unrecognised status gracefully rather than throwing.

### The rest

| Method                     | What it does                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `release(name, options?)`  | Stop using a configuration in this tab. Other tabs keep working. Pass `{ forgetDevice: true }` to also revoke the browser permission. |
| `releaseAll(options?)`     | The same for every configuration.                                                                                                     |
| `requestAccess(name)`      | Show the port picker. Returns `false` if the user dismissed it.                                                                       |
| `restore()`                | Set up everything persisted by an earlier visit. Returns the names.                                                                   |
| `exists(name)` / `names()` | What is set up in this tab.                                                                                                           |
| `configure(options)`       | `workerUrl`, `transport`, `logger`, `logPayloads`. Before any other call.                                                             |
| `isSupported()`            | Whether this browser can support the library at all.                                                                                  |
| `dispose()`                | Release everything. Rarely needed; a closing tab does it anyway.                                                                      |

## Errors

Every failure is a `SerialBrokerError` with a stable `code`, structured `context`, and a
`remediation` sentence written for the developer reading it at the time.

```ts
try {
  await SerialBroker.send('Printer', 'CUT');
} catch (error) {
  if (error instanceof SerialBrokerError) {
    console.error(error.code, error.remediation, error.context);
  }
}
```

Branch on `code`, never on `message` — messages change, codes do not. The full list is in
[`src/core/error-codes.ts`](./src/core/error-codes.ts), each with its remediation.

One code deserves attention: **`OWNER_LOST_DURING_WRITE`**. It means the tab that owned the
port went away while your write was in progress, and whether the device received the bytes
is genuinely unknowable. The library does **not** retry it — repeating a command to a device
that cuts, dispenses or moves something is worse than not sending it. Only your application
knows whether its command is idempotent.

## Logging

The library writes nothing to the console on its own. Opt in:

```ts
SerialBroker.configure({
  logger: {
    log: (level, message, fields) => console[level](message, fields),
  },
});
```

Records about a configuration carry `clientId` and `configName`, so records from several tabs
can be correlated in one console. Payload bytes never appear above `debug` level — serial traffic
routinely carries card numbers and PINs.

## Diagnostics

When something is wrong in a deployment, the question is usually the one this API refuses to
answer: which tab has the port, and what is it doing? A separate entry point answers it for
operators, without the application having to change:

```ts
import { openDiagnostics } from 'serial-broker/diagnostics';

const diagnostics = openDiagnostics({ workerUrl: '/assets/serial-broker.worker.js' });
const { participants, locks } = await diagnostics.collect();
```

Every tab reports its role, status, effective settings, listeners and pending writes; the owner
adds its connection state, reconnect attempts, when it will next try, and bytes in and out. The
observer takes no part in ownership, so looking never moves the port. Pass the same `workerUrl` and
`transport` as the application, or it will be looking at an empty bus. See
[ADR-0018](./docs/adr/0018-diagnostics-observer.md).

## Debugging surface

The package ships a page that shows every setting and every piece of status, in `dist/debug/`:
this tab's configurations exactly as the API reports them, and next to them every tab of the
origin through the diagnostics observer — which tab owns each port, reconnect timing, pending
writes, settings, locks, and live traffic. It sets nothing up on its own, so opening it never
moves a port.

It is static content. Nothing serves it unless you do, and whether to is your decision: it can send
bytes to devices and revoke device permissions. Serve it on the application's origin, next to the
worker or pointed at the application's worker URL. See [debug/README.md](./debug/README.md).

## What this library does not do

It wraps the transport and nothing else. It delivers byte chunks exactly as they arrive, with
**no framing**: one logical message can arrive in five chunks, and five can arrive in one.
Delimiters, checksums, escaping and request/response correlation belong to a protocol layer
built on top of this one. A line assembler is about ten lines:

```ts
let buffer = '';
SerialBroker.subscribe('Reader', 'onReceive', (event) => {
  buffer += event.text ?? '';
  const lines = buffer.split('\r\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) handleLine(line);
});
```

It also never hands out the underlying `SerialPort`: one tab closing a port the others depend
on would break every guarantee above.

## Known limitations

- **Two identical devices cannot be told apart.** The platform exposes only USB vendor and
  product IDs, not a serial number. With two identical adapters attached, the library uses the
  first granted one and warns. The same applies, more strongly, to a `{ any: true }`
  configuration, which cannot distinguish ports at all.
- **Data can be lost during a handover.** When the owning tab dies, the browser closes its
  port; the successor reopens it, and anything the device sent in between went to nobody. This
  is a property of the platform, not a bug that can be fixed here.
- **Writes from different tabs have no defined relative order.** Writes from _one_ tab are
  strictly ordered and never interleaved. Across tabs, whoever gets there first wins — if you
  need command atomicity across tabs, build it on top.
- **Mixed library versions partition.** Tabs running different wire protocol versions do not
  coordinate with each other: the group that comes second cannot open the device and keeps
  reconnecting. They detect each other and report `PROTOCOL_VERSION_MISMATCH`; reload all tabs
  after deploying a version that changes the protocol.

## How it works

Enough to know whether it will do what you need; the full reasoning is in
[the ADRs](./docs/adr/).

- **The port lives in a window, not in the worker.** `navigator.serial` is not exposed to
  workers at all, so the owner is an ordinary tab — which is why failover has to exist.
  ([ADR-0004](./docs/adr/0004-port-ownership-lives-in-a-window.md))
- **Ownership is a Web Lock.** Holding the lock _is_ being the owner. The browser releases it
  when a context dies, however it dies, and grants it to the longest-waiting tab. No
  heartbeat, no timeout, no split brain.
  ([ADR-0005](./docs/adr/0005-owner-election-via-web-locks.md))
- **A `SharedWorker` routes messages** between tabs, and does nothing else — it does not touch
  the port, decide ownership, or hold your writes.
  ([ADR-0006](./docs/adr/0006-sharedworker-as-message-broker.md))
- **Delivery is at-most-once.** Never exactly-once, because a raw serial port cannot
  acknowledge anything, and claiming otherwise would be a lie.
  ([ADR-0013](./docs/adr/0013-write-ordering-and-delivery-semantics.md))

## Development

```sh
npm install
npm test          # unit and integration tests
npm run verify    # format, lint, types, tests with coverage gates, build
```

The test suite simulates a browser: several tabs, a lock manager with real Web Locks
semantics including release-on-death, and devices that can be unplugged or made to hang
mid-write. Everything that makes this library difficult is an ordinary deterministic test —
see [`test/harness/`](./test/harness/) and the scenario matrix in
[docs/guidelines/testing.md](./docs/guidelines/testing.md).

Before changing anything, read [the engineering guidelines](./docs/guidelines/). They are
binding.

## Licence

MIT
