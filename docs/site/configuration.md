# Configuration

Two calls take options. `setup()` describes one configuration: which device, how to open it, how to
keep it connected, how to collect and decode what it sends, and whether to remember it.
`configure()` sets library-wide options before the first configuration is set up. This chapter
describes every option: what it does, its default and range, what it costs, and when to change it.
What the options lead to at run time is described in [Guarantees](guarantees.md).

Every option is validated when it is passed — those of `setup()`, `configure()` and `release()`
alike. An invalid value fails the call with `INVALID_ARGUMENT`, nothing of the call is applied, and
`error.context.argumentName` names the field, such as `options.serial.baudRate`. Each option is read
once, when the call is made, and copied: a framework's reactive proxy is fine, and changing the
object afterwards changes nothing.

```ts
await SerialBroker.setup('Scale', {
  device: { vendorId: 0x0403, productId: 0x6001 },
  serial: { baudRate: 19_200, parity: 'even' },
  connection: { maxAttempts: 20 },
  receive: { idleMs: 100 },
  encoding: { decodeText: true },
  remember: true,
  maxTabs: Infinity,
});
```

## Whose settings apply

A configuration name is set up separately in every tab, and each tab may pass its own options.
**serial-broker does not compare most options between tabs.** Which tab's options take effect
depends on the option:

| Options                                                                | Taken from                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `device`, `serial`                                                     | The tab that holds the port, when it opens it. A tab in auto mode adopts the holder's.    |
| `connection`, except `writeTimeoutMs`                                  | The tab that holds the port.                                                              |
| `connection.writeTimeoutMs`                                            | Each tab for its own writes, for the whole `send()`; the holding tab's, at the port.      |
| `receive`, `encoding.decodeText`, and `encoding.encoding` for decoding | The tab that holds the port. Its deliveries reach every tab.                              |
| `encoding.encoding` for sending, `remember`                            | Each tab for itself.                                                                      |
| `maxTabs`                                                              | Every tab alike. A tab running a different limit than the tab holding the port withdraws. |

In practice: **pass the same options for a name in every tab.** When the port moves to another tab,
that tab's settings apply. An application that lets the user change settings has to tell its other
tabs, as the [full-featured example](examples/full-featured.md) does. The
[debugging surface](diagnostics.md#the-debugging-surface) marks a configuration whose tabs run
different settings.

### Calling `setup()` again

Within one tab, a name is one configuration, whichever code set it up: there is no count, and one
`release()` ends it for every caller.

- **With the same device, line settings and `maxTabs`**, `setup()` does nothing to a working
  configuration. A `failed` configuration it starts again, from any tab: a tab that does not hold
  the port asks the tab that does. A tab that withdrew over a different `maxTabs` stays `failed`
  until it is released.
- **With a different `device`, `baudRate`, `dataBits`, `stopBits`, `parity`, `flowControl`,
  `bufferSize` or `maxTabs`**, `setup()` fails with `CONFIGURATION_CONFLICT`. Release the
  configuration first, then set it up with the new options.
- **Other options passed to a second `setup()`** in the same tab, `remember` among them, are
  ignored.

A `device` in auto mode never conflicts with one in auto mode, whatever either has resolved to.
While it has resolved to nothing, it conflicts with no explicit device either, and the running
configuration keeps what it has; once resolved, it counts as the device it resolved to.

## `name`

The name addresses the configuration in every other call, and appears in the ownership lock, the
storage key and every log record.

- **Type:** string, 1–128 characters, with no control characters and no unpaired surrogates.
- **Choose it** after the device's role in the application — `Scale`, `CardReader` — not after the
  port, which the application cannot identify anyway.

## `device`

Which device the configuration connects to. Optional: left out, the device is taken from the port
the user chooses. Given, it is exactly one of four shapes; passing two at once is
`INVALID_ARGUMENT`.

| Shape                        | Matches                                   | Port picker             | Use it for                                      |
| ---------------------------- | ----------------------------------------- | ----------------------- | ----------------------------------------------- |
| omitted, or `{ auto: true }` | the port the user chose, once chosen      | unfiltered until chosen | most applications; the default                  |
| `{ vendorId, productId }`    | the first granted port with these USB IDs | filtered to these IDs   | a known USB device                              |
| `{ nonUsb: true }`           | the first granted port without USB IDs    | unfiltered              | a built-in or virtual port next to USB adapters |
| `{ any: true }`              | the first granted port                    | unfiltered              | a single port of any kind                       |

**Use USB IDs, or let auto mode take them from the chosen port, whenever the device has them.** With
`{ nonUsb: true }` or `{ any: true }`, and with two identical USB devices, serial-broker cannot tell
granted ports apart: it uses the first and logs `matcher.ambiguous`.

### Omitted, or `{ auto: true }` — auto mode

- **What it does:** the configuration waits with `awaiting-permission` until `requestAccess()` opens
  the picker, unfiltered, and takes its device from the port the user chooses: its USB IDs when it
  reports both, or the fact that it has none. From then on it behaves like the explicit shape it
  resolved to — matching, picker filter, `getStatus()` — and stays in auto mode.
- **Remembered:** the resolved device is written into the remembered configuration as
  `{ auto: true, resolved: { vendorId, productId } }` or `{ auto: true, resolved: { nonUsb: true } }`.
  On a later visit, `setup()` in auto mode takes the device from the configuration remembered under
  the same name, and so does `restore()`, so the port opens without a prompt. Only a remembered
  auto-mode resolution is taken — not a device the remembered configuration named explicitly — and
  nothing is taken with `remember: false`. Passing `resolved` yourself seeds the resolution, and wins
  over the remembered one.
- **Shared:** a tab in auto mode adopts the device of the tab holding the port, whether that tab chose
  it in the picker or named it. Choose it once, in any tab.
- **Change the device:** when an adapter is swapped for another model, call
  `requestAccess(name, { chooseAgain: true })` from a click, in any tab. The picker is unfiltered,
  the port chosen becomes the device of every tab and is remembered, and the tab holding the port
  closes the old device and opens the new one, also while it is open. Dismissing the picker changes
  nothing. A configuration that names its device rejects this with `INVALID_ARGUMENT`: set it up
  with the other device instead.
- **Keep in mind:** until the user has chosen, an auto-mode configuration matches no granted port,
  even when only one is granted; `getStatus().deviceKind` is `'auto'` then. `setup()` and
  `requestAccess()` may follow each other in one click.
- **When to change it:** name the USB IDs when the application must never open anything but one kind
  of device, and the picker should offer nothing else. The decision and its reasons are in ADR-0036.

### `{ vendorId, productId }`

- **Type:** integers, `0x0000`–`0xffff`.
- **What it does:** among the ports the user has granted, the first whose USB identity matches is
  used. The port picker is filtered to devices with these IDs, and a port granted on an earlier
  visit opens with no prompt.
- **Keep in mind:** the IDs name a kind of device, not a particular one. With two identical adapters
  granted, the first one is used and a warning is logged. Browsers expose no serial number to tell
  them apart. [First connection](first-connection.md#finding-a-devices-usb-ids) shows where to find
  the IDs.

### `{ nonUsb: true }`

- **What it does:** accepts only ports that report no USB identity, and shows the picker unfiltered.
  A port that reports only one of the two USB IDs counts as having none.
- **When:** for a built-in RS-232 interface, a Bluetooth serial port or a virtual COM port, where a
  USB adapter may be granted on the same origin and must be left alone. It is also what auto mode
  resolves to for such a port.
- **Cost:** with more than one such port granted, the library cannot tell them apart.

### `{ any: true }`

- **What it does:** accepts whatever port the user granted, and shows the picker unfiltered.
- **When:** when exactly one port is granted on the origin and any kind will do.
- **Cost:** with more than one port granted, the library cannot tell them apart, and the
  configuration matches ports that other configurations use as well.

## `serial`

Passed to `SerialPort.open()`. The device dictates these; they are not a matter of preference.

| Option        | Type and range                | Default    |
| ------------- | ----------------------------- | ---------- |
| `baudRate`    | integer, 1 – 20,000,000       | `required` |
| `dataBits`    | `7` or `8`                    | `8`        |
| `stopBits`    | `1` or `2`                    | `1`        |
| `parity`      | `'none'`, `'even'` or `'odd'` | `'none'`   |
| `bufferSize`  | integer, 1 byte – 16 MiB      | `255`      |
| `flowControl` | `'none'` or `'hardware'`      | `'none'`   |

`baudRate`
: Bits per second, as the device's manual gives it. The range is deliberately generous: which rates
work is a property of the adapter, and `open()` reports a rate it cannot use as `OPEN_FAILED`.

`dataBits`, `stopBits`, `parity`
: Must match the device exactly. A mismatch does not fail — it produces garbage, usually visible as
replacement characters in decoded text or as `READ_FAILED`.

`bufferSize`
: The size of the buffers the browser allocates for the port, one for each direction. It is also the
most one read returns. The default suits most devices. **Raise it** for a device that sends large
bursts faster than the page reads them. **Cost:** memory in the browser, twice over; and a write that
fits in the transmit buffer resolves as soon as it is there, before the device has taken it — a
larger buffer makes more writes resolve early, not faster
([What a resolved send means](guarantees.md#what-a-resolved-send-means)).

`flowControl`
: `'hardware'` uses RTS/CTS. Enable it only if the device and cable support it: with a device that
never asserts CTS, every write waits and eventually fails with `WRITE_TIMEOUT`.

## `connection`

How the tab holding the port keeps the connection open, and how long operations may take. The rules
these settings feed are in [Reconnecting](guarantees.md#reconnecting).

| Option               | Type and range                        | Default    |
| -------------------- | ------------------------------------- | ---------- |
| `autoReconnect`      | boolean                               | `true`     |
| `initialDelayMs`     | integer, 0 – 3,600,000                | `250`      |
| `factor`             | number, 1 – 100                       | `2`        |
| `maxDelayMs`         | integer, 0 – 3,600,000                | `30000`    |
| `jitter`             | number, 0 – 1                         | `0.5`      |
| `maxAttempts`        | integer, 0 – 1,000,000, or `Infinity` | `Infinity` |
| `stableAfterMs`      | integer, 0 – 3,600,000                | `5000`     |
| `openTimeoutMs`      | integer, 1 – 600,000                  | `10000`    |
| `writeTimeoutMs`     | integer, 1 – 600,000                  | `5000`     |
| `maxWriteChunkBytes` | integer, 1 byte – 16 MiB              | `4096`     |

### Reconnecting

`autoReconnect`
: Whether the tab holding the port reconnects by itself. With `false`, a lost connection or a failed
attempt ends in `failed` with the error reported, and nothing is tried again — not after a delay,
and not when the device is plugged in again. The application decides when to try: calling `setup()`
again with the same options, in any tab, starts the configuration again. A handover does not start
it either: when the tab holding a `failed` configuration closes or crashes, the tab taking the port
over stays `failed`, as every other tab does. The errors of the loss carry `isRetryable: false`. Only
a configuration still in `awaiting-permission` — it never found its device — connects when the
device appears; that is its first connection, not a reconnect. A first attempt that fails ends in
`failed` too. A page that loads while no other tab runs the configuration knows nothing of the
failure, and connects when it sets the configuration up: that is the application asking. **Set it
to `false`** on a production line where a lost device must be acknowledged by a
person before the application talks to it again. **Cost:** every glitch — a loose cable, an adapter
reset on wake — needs the application to act.

The delay before reconnect attempt _n_ is

```text
delay(1) = 0
delay(n) = min(maxDelayMs, initialDelayMs × factor^(n−2)) × random(jitter … 1)
```

With the defaults the attempts come immediately, then after about 125–250 ms, 250–500 ms,
0.5–1 s, and so on, levelling off at 15–30 s. When the browser reports that the device has been
plugged in again, the next attempt is made at once regardless of the delay.

`initialDelayMs`
: The delay before the second attempt. **Lower it** for a device that restarts quickly. Raising it
gains little, since the delay grows anyway.

`factor`
: How fast the delay grows. `1` retries at a constant `initialDelayMs`, which suits a device that is
expected back within seconds; larger values back off faster. **Cost** of a low value: more attempts,
each of which lists the granted ports and may try to open one.

`maxDelayMs`
: The longest the tab holding the port waits between attempts — and so the longest a device that
comes back without the browser noticing stays disconnected, such as one switched on behind an adapter
that stayed plugged in. **Lower it** when that matters more than the few cheap attempts it costs.

`jitter`
: How much each delay is randomised: each is drawn between `jitter × delay` and `delay`. It spreads
the attempts of many configurations that failed together, such as several devices behind one power
switch. `1` disables it.

`maxAttempts`
: Attempts before the status becomes `failed` and `RECONNECT_EXHAUSTED` is reported. A failed
configuration still tries again when the device is plugged in again, and when `setup()` is called
for it again. `0` gives up at the first failure but, unlike `autoReconnect: false`, still revives on
replug. **Set a limit** when a device that stays away should be shown as a problem rather than as
endlessly reconnecting.

`stableAfterMs`
: How long a connection has to hold before the attempt counter starts again from the beginning.
Without it, a device that opens and immediately drops would retry at the shortest delay forever.
**Raise it** for a device that tends to drop again some seconds after it opens.

### Timeouts and chunks

`openTimeoutMs`
: The deadline for opening and closing the port. A driver that hangs in `open()` would otherwise
block the connection indefinitely; a timeout counts as a failed attempt, reported as `OPEN_TIMEOUT`.
**Raise it** only for an adapter known to take long to open.

`writeTimeoutMs`
: Three deadlines in one. In the tab that called `send()`, the whole write, counted from `send()`,
including waiting for a connection. The tab holding the port begins no write without that tab's
approval, which it no longer gives once this deadline has run, so tabs may set it differently. In the
tab holding the port, how long a write may wait there before it begins — behind other writes, and for
the approval of the tab that issued it; one that waited longer is never begun — and how long the
device has to take each chunk.
**Raise it** for a large payload to a slow device, or a device that applies flow control for long
stretches; up to ten minutes. **Lower it** when a user is waiting for the result. **Cost** of a high
value: a device that stopped taking data is noticed later, and the writes behind a stuck one wait
that much longer before they fail.

`maxWriteChunkBytes`
: Large payloads are handed to the port in chunks of at most this size. The bytes of one `send()` are
never interleaved with another's, whatever the chunk size. **Lower it** for a device with a small
receive buffer that drops the tail of a large write instead of slowing the sender down. **Cost:** more,
smaller writes, each with its own deadline.

## `receive`

How what the device sends is collected into `onReceive` events (ADR-0039).

| Option      | Type and range         | Default |
| ----------- | ---------------------- | ------- |
| `idleMs`    | integer, 0 – 3,600,000 | `50`    |
| `maxWaitMs` | integer, 1 – 3,600,000 | `500`   |

A read from the port returns whatever the driver holds at that moment, and a device that answers
byte by byte — an echo, a slow microcontroller — would produce one event per byte: `1`, `2`, `3`,
`4`, `\r`, `\n` for the answer `1234\r\n`. The tab holding the port therefore collects what it reads
and delivers it as one event, in every tab, once the line has been quiet for `idleMs`. What was
collected is also delivered at once when 64 KiB have come together, and when the connection ends,
before its status changes.

`idleMs`
: How long the line has to be quiet before what was collected is delivered. The default of 50 ms
joins an answer from a device that sends a byte every few milliseconds, and is below what a person
notices. **Raise it** for a device that pauses inside its answers. **Set it to `0`** to deliver every
read as it arrives, with no delay, for an application that reacts to single bytes. **Cost:** every
delivery comes up to `idleMs` after the device stopped sending; a lower value sends more, smaller
messages to every tab.

`maxWaitMs`
: The longest a delivery waits after its first byte, however busy the line stays. A device that
streams without pause is delivered at this pace instead of never. **Lower it** when a streaming
device's data has to appear sooner.

The settings of the tab holding the port apply in every tab, and a difference between tabs is not a
`CONFIGURATION_CONFLICT`. Nothing is split at a delimiter: the boundaries of an event carry no
meaning, and a message can still arrive in two events when the device pauses inside it.

## `encoding`

| Option       | Type and range                                               | Default   |
| ------------ | ------------------------------------------------------------ | --------- |
| `encoding`   | a label `TextDecoder` accepts, kept under its canonical name | `'utf-8'` |
| `decodeText` | boolean                                                      | `false`   |

`decodeText`
: Adds `text` to every `onReceive` event, decoded with a streaming decoder so a character split
across two reads arrives whole. The bytes are in `data` either way. The text is decoded by the tab
holding the port, so its setting applies in every tab. **Cost:** every delivery carries the text as
well as the bytes to every tab. **Leave it off** for binary protocols.

`encoding`
: The encoding received text is decoded with, such as `'windows-1252'` for an older device. Strings
passed to `send()` are always encoded as UTF-8; with any other encoding configured, sending a string
fails with `INVALID_ARGUMENT`, and the application has to encode the bytes itself.

## `remember`

| Option     | Type and range | Default |
| ---------- | -------------- | ------- |
| `remember` | boolean        | `true`  |

- **What it does:** remembers the configuration in `localStorage`, so that `restore()` sets it up
  again after a reload, and `setup()` in auto mode finds the device the user chose.
- **Set it to `false`** for a configuration the application always sets up itself with a named
  device, or one that should not outlive the page. An auto-mode configuration with `remember: false`
  asks the user again on every visit.
- **Keep in mind:** what is remembered is one entry per name for the whole origin, shared by every
  tab. A plain `release()` does not forget it — see [`release()`](#release) — and neither does
  closing, reloading or crashing a tab. `release(name, { forget: true })` does, but only once no
  other tab still runs the configuration with `remember: true`. A tab setting the name up with
  `remember: false` forgets an entry left behind by an earlier setup, under the same condition. The
  tab that saved last decides the remembered options.
- **Where it is kept:** one `localStorage` key per configuration,
  `serial-broker/configurations/v1/entry/<name>`, listed in `serial-broker/configurations/v1/index`.
  An entry that cannot be read — hand-edited, truncated, written by a version whose options no longer
  validate — is discarded on its own, with `STORAGE_CORRUPT` reported, and the other configurations
  are restored as usual. Where `localStorage` cannot be used, nothing is remembered beyond the page.

The browser remembers the device permission independently of this option.

## `maxTabs`

| Option    | Type and range                  | Default    |
| --------- | ------------------------------- | ---------- |
| `maxTabs` | integer, 1 – 100, or `Infinity` | `Infinity` |

- **What it does:** at most this many tabs of the origin use the configuration at the same time, the
  tab holding the port included. Every tab with a limit starts at `queued`, and moves on as soon as it
  has a place, at once when one is free. A tab beyond the limit stays `queued`: it receives nothing,
  and its writes wait for their deadline. When another tab releases the configuration, closes or
  crashes, the tab that has waited longest takes its place. See
  [Limiting how many tabs use a port](shared-ports.md#limiting-how-many-tabs-use-a-port).
- **Set it to `1`** when only one tab may drive the device at a time — a machine operated from one
  screen. Larger values bound how many tabs follow the device's traffic.
- **Cost:** each waiting tab requests every place as a Web Lock.
- **Keep in mind:** every tab has to pass the same value. A tab that finds the tab holding the port
  running a different limit reports `CONFIGURATION_CONFLICT`, withdraws, and shows `failed` until it
  is released and set up again. Only tabs of the same origin are counted.

## `configure()`

Library-wide options. Call `configure()` before any other `SerialBroker` method: the first call that
needs serial-broker's internal client creates it with the options set so far. (`exists()`,
`names()`, `unsubscribe()`, `release()`, `releaseAll()` and `isSupported()` create nothing while
nothing is set up.) A later `configure()` does not reach that client; it logs the warning
`facade.late-configure`, and its options apply only after `dispose()`. Options passed in several
calls are merged.

| Option        | Type                                               | Default                                   |
| ------------- | -------------------------------------------------- | ----------------------------------------- |
| `workerUrl`   | non-empty string or `URL`                          | the script next to the library's ES build |
| `transport`   | `'auto'`, `'sharedworker'` or `'broadcastchannel'` | `'auto'`                                  |
| `logger`      | object with a `log(level, message, fields)` method | none: nothing is logged                   |
| `logPayloads` | boolean                                            | `false`                                   |

`workerUrl`
: The URL of `serial-broker.worker.js`. Needed when the bundler does not emit the script by itself,
and **required** with the CommonJS build and the classic script build, neither of which can find
the script by itself. Every tab must use the same URL; see
[The worker script](installing.md#the-worker-script).

`transport`
: `'auto'` uses a `SharedWorker`, and a `BroadcastChannel` where the browser has no `SharedWorker`,
refuses to create one, or cannot load its script. `'broadcastchannel'` always uses the channel.
`'sharedworker'` never does: where the worker cannot be created, `setup()` fails with
`BROKER_UNAVAILABLE`, and a script that fails to load is reported as `BROKER_UNAVAILABLE` through
`onError`. **Use `'sharedworker'` in development**, to notice a worker script that is not being
served; in production, `'auto'` keeps working without it.

`logger`
: Receives structured log records. Without one, serial-broker writes nothing anywhere. See
[Logging](diagnostics.md#logging).

`logPayloads`
: Adds the first 64 bytes of every transfer, as hex, to `debug` records, next to its full length.
Off by default, because serial traffic can carry card numbers and PINs. Byte counts are logged
either way. The setting is read when the library builds its internals, and payload records come from
the tab holding the port, so every tab has to set it. **Cost:** large records,
and sensitive data in the log.

## `release()`

| Option         | Type    | Default |
| -------------- | ------- | ------- |
| `forget`       | boolean | `false` |
| `forgetDevice` | boolean | `false` |

`release(name)` stops using the configuration in this tab and closes the port if this tab held it.
**It forgets nothing**: both options default to `false`, so the configuration stays remembered and
the browser's permission stays granted, and `restore()` or a later `setup()` brings the connection
back without a prompt. A disconnect is not a deletion; the application decides when something is
forgotten.

`forget`
: `false` keeps the configuration remembered under this name. `true` removes it, so `restore()` no
longer brings it back and a later `setup()` starts from nothing. The entry belongs to the origin, so
it is removed only once no tab still runs the configuration with `remember: true`; a configuration
set up with `remember: false` has nothing stored under its name, and `forget` does nothing for it —
that is not an error.

`forgetDevice`
: `false` keeps the browser's permission for the device, so the next `setup()` needs no prompt.
`true` also revokes it, for every tab of the origin, so the user is asked again.

The two are independent, and each names a different store: serial-broker keeps the configuration,
the browser keeps the permission. `{ forget: true, forgetDevice: true }` removes every trace of the
configuration in this browser. `releaseAll()` takes the same options and applies them to every
configuration of the tab.
