# Configuration

Two calls take options. `setup()` describes one configuration: which device, how to open it, how
to keep it connected, how to treat text, and whether to remember it. `configure()` sets
library-wide options before the first configuration is set up.

Every option is validated when it is passed. An invalid value fails the call with
`INVALID_ARGUMENT`, and `error.context.argumentName` names the field, such as
`options.serial.baudRate`.

## Whose settings apply

A configuration name is set up separately in every tab, and each tab may pass its own options.
**serial-broker does not compare options between tabs.** Which tab's options take effect depends
on the option:

| Options                                                         | Taken from                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `device`, `serial`                                              | The tab that holds the port, when it opens it.                         |
| `connection` except `writeTimeoutMs`, and `encoding.decodeText` | The tab that holds the port.                                           |
| `connection.writeTimeoutMs`                                     | The tab that issued the write — and the holding tab's, for each chunk. |
| `encoding.encoding` for sending, `persist`                      | Each tab for itself.                                                   |

In practice: **pass the same options for a name in every tab.** An application that lets the user
change them has to tell its other tabs, as the [full-featured example](examples/full-featured.md)
does. The [debugging surface](diagnostics.md) marks a configuration whose tabs run different
settings.

Within one tab, calling `setup()` again for a name with the same device and line settings does
nothing. Calling it with a different `device`, `baudRate`, `dataBits`, `stopBits`, `parity`,
`flowControl` or `bufferSize` fails with `CONFIGURATION_CONFLICT`; release the configuration first. Other options
passed to a second `setup()` in the same tab are ignored.

## `name`

The name addresses the configuration in every other call, and appears in the ownership lock, the
storage key and every log record.

- **Type:** string, 1–128 characters, no control characters.
- **Choose it** after the device's role in the application — `Scale`, `CardReader` — not after
  the port, which the application cannot identify anyway.

## `device`

Which device the configuration connects to. Exactly one of two shapes.

### `{ vendorId, productId }`

- **Type:** integers, `0x0000`–`0xffff`.
- **What it does:** among the ports the user has granted, the first whose USB identity matches is
  used. The port picker is filtered to devices with these IDs.
- **Keep in mind:** the IDs name a kind of device, not a particular one. With two identical
  adapters granted, the first one is used and a warning is logged. Browsers expose no serial
  number to tell them apart.

### `{ any: true }`

- **What it does:** accepts whatever port the user granted, and shows the picker unfiltered.
- **When:** for ports with no USB identity — a built-in RS-232 interface, a Bluetooth serial port,
  a virtual COM port. `getInfo()` reports no IDs for these, so there is nothing to filter on.
- **Cost:** with more than one such port granted, the library cannot tell them apart. Use USB IDs
  whenever the device has them.

## `serial`

Passed to `SerialPort.open()`. The device dictates these; they are not a matter of preference.

| Option        | Type and range                | Default  |
| ------------- | ----------------------------- | -------- |
| `baudRate`    | integer, 1–20,000,000         | required |
| `dataBits`    | `7` or `8`                    | `8`      |
| `stopBits`    | `1` or `2`                    | `1`      |
| `parity`      | `'none'`, `'even'` or `'odd'` | `'none'` |
| `bufferSize`  | integer, 1 byte – 16 MiB      | `255`    |
| `flowControl` | `'none'` or `'hardware'`      | `'none'` |

`baudRate`
: Bits per second, as the device's manual gives it. The range is deliberately generous: which
rates work is a property of the adapter, and `open()` reports a rate it cannot use.

`dataBits`, `stopBits`, `parity`
: Must match the device exactly. A mismatch does not fail — it produces garbage, usually visible
as replacement characters in decoded text.

`bufferSize`
: The size of the read buffer the browser allocates. The default suits most devices. Raise it for
a device that sends large bursts faster than the page reads them; there is no benefit beyond that.

`flowControl`
: `'hardware'` uses RTS/CTS. Enable it only if the device and cable support it: with a device that
never asserts CTS, every write waits and eventually fails with `WRITE_TIMEOUT`.

## `connection`

How the tab holding the port keeps the connection open, and how long operations may take. See
[When the device goes away](shared-ports.md#when-the-device-goes-away) for the behaviour in
context.

| Option               | Type and range                        | Default    |
| -------------------- | ------------------------------------- | ---------- |
| `initialDelayMs`     | integer, 0 – 3,600,000                | `250`      |
| `factor`             | number, 1–100                         | `2`        |
| `maxDelayMs`         | integer, 0 – 3,600,000                | `30000`    |
| `jitter`             | number, 0–1                           | `0.5`      |
| `maxAttempts`        | integer, 0 – 1,000,000, or `Infinity` | `Infinity` |
| `stableAfterMs`      | integer, 0 – 3,600,000                | `5000`     |
| `openTimeoutMs`      | integer, 1 – 600,000                  | `10000`    |
| `writeTimeoutMs`     | integer, 1 – 600,000                  | `5000`     |
| `maxWriteChunkBytes` | integer, 1 byte – 16 MiB              | `4096`     |

### Reconnecting

The delay before reconnect attempt _n_ is

```text
delay(1) = 0
delay(n) = min(maxDelayMs, initialDelayMs × factor^(n−2)) × random(jitter … 1)
```

With the defaults the attempts come immediately, then after about 125–250 ms, 250–500 ms,
0.5–1 s, and so on, levelling off at 15–30 s. When the browser reports that the device has been
plugged in again, the next attempt is made at once regardless of the delay.

`initialDelayMs`
: The delay before the second attempt. Lower it for a device that restarts quickly; raising it
gains little, since the delay grows anyway.

`factor`
: How fast the delay grows. `1` retries at a constant `initialDelayMs`, which suits a device that is
expected back within seconds; larger values back off faster.

`maxDelayMs`
: The longest the tab holding the port waits between attempts — and so the longest a device that
comes back without the browser noticing stays disconnected. Lower it when that matters more than
the few cheap attempts it costs.

`jitter`
: How much each delay is randomised: each is drawn between `jitter × delay` and `delay`. It spreads
the attempts of many configurations that failed together, such as several devices behind one
power switch. `1` disables it.

`maxAttempts`
: Attempts before the status becomes `failed` and `RECONNECT_EXHAUSTED` is reported. A failed
configuration still revives when the device is plugged in again. Set a limit when a device that
stays away should be shown as a problem rather than as endlessly reconnecting.

`stableAfterMs`
: How long a connection has to hold before the attempt counter starts again from the beginning.
Without it, a device that opens and immediately drops would retry at the shortest delay forever.

### Timeouts

`openTimeoutMs`
: The deadline for opening and closing the port. A driver that hangs in `open()` would otherwise
block the connection indefinitely; a timeout counts as a failed attempt.

`writeTimeoutMs`
: The deadline for one `send()` in the tab that called it, including the time spent waiting for a
connection; and, in the tab holding the port, for each chunk handed to the device. Raise it for a
device that applies flow control for long stretches; lower it when a user is waiting for the
result.

`maxWriteChunkBytes`
: Large payloads are handed to the device in chunks of at most this size. The bytes of one `send()`
are never interleaved with another's, whatever the chunk size. Lower it for a device with a small
receive buffer that drops the tail of a large write instead of slowing the sender down.

## `encoding`

| Option       | Type                          | Default   |
| ------------ | ----------------------------- | --------- |
| `encoding`   | a label `TextDecoder` accepts | `'utf-8'` |
| `decodeText` | boolean                       | `false`   |

`decodeText`
: Adds `text` to every `onReceive` event, decoded with a streaming decoder so a character split
across two chunks is decoded correctly. The bytes are in `data` either way. The text is decoded
by the tab holding the port, so its setting applies in every tab.

`encoding`
: The encoding received text is decoded with. Strings passed to `send()` are always encoded as
UTF-8; with any other encoding configured, sending a string fails with `INVALID_ARGUMENT`, and the
application has to encode the bytes itself.

## `persist`

- **Type:** boolean. **Default:** `true`.
- **What it does:** remembers the configuration in `localStorage`, so `restore()` can set it up
  again after a reload.
- **Set it to `false`** for a configuration the application always sets up itself with fixed
  options, or one that should not outlive the page.

The browser remembers the device permission independently of this option.

## `configure()`

Library-wide options. Call `configure()` before any other `SerialBroker` method: the first of them
creates serial-broker's internal client with the options set so far, and later calls to
`configure()` do not reach it. Options passed in several calls are merged.

`workerUrl`
: The URL of `serial-broker.worker.js`. Needed only when the bundler does not emit the script by
itself. Every tab must use the same URL; see [The worker script](installing.md#the-worker-script).

`transport`
: `'auto'` (the default) uses a `SharedWorker`, and a `BroadcastChannel` where the browser has no
`SharedWorker`, refuses to create one, or cannot load its script. `'broadcastchannel'` always
uses the channel. `'sharedworker'` never does: where the worker cannot be created, `setup()`
fails with `BROKER_UNAVAILABLE`, and a script that fails to load is reported as
`BROKER_UNAVAILABLE` through `onError`. Useful in development, to notice a worker script that is
not being served.

`logger`
: Receives structured log records. Without one, serial-broker writes nothing anywhere. See
[Diagnostics](diagnostics.md#logging).

`logPayloads`
: Adds the bytes of every transfer, as hex, to `debug` records. Off by default, because serial
traffic can carry card numbers and PINs. Byte counts are logged either way.

## `release()`

`forgetDevice`
: `false` by default: the browser keeps its permission for the device, so the next `setup()` needs
no prompt. `true` also revokes the permission, so the user is asked again.
