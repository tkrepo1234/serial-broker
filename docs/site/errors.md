# Errors

Every failure serial-broker reports is a `SerialBrokerError` with a stable code. This chapter
explains how errors reach the application, what an error carries, and what every code means.

## How errors reach the application

**As the result of a call.** A call that fails rejects its promise — or, for the synchronous
methods `subscribe()`, `unsubscribe()`, `getStatus()` and `exists()`, throws. These are failures of
that call: an invalid argument, a name that is not set up, a write that did not complete.

**Through `onError`.** Everything that goes wrong without a call to answer for it — the device was
unplugged, the port did not open, a listener threw — is delivered as an `onError` event:

```ts
SerialBroker.subscribe('Scale', 'onError', (event) => {
  console.warn(event.error.code, event.error.remediation);
});
```

Where such an event is delivered depends on where it arose:

- **A failure of the connection** arises in the tab holding the port and is delivered in **every**
  tab that has the configuration set up.
- **A listener that threw** is delivered only in the tab whose listener it was: no other tab can do
  anything about it.
- **A failure of one tab's environment** — its message bus, its storage, a tab on another protocol
  version — is delivered only in that tab, to each of its configurations. If nothing in the tab
  listens for `onError` yet, the latest such errors, up to 16, are kept and delivered to the first
  `onError` listener registered afterwards. They also reach the [log](diagnostics.md#logging).

A listener registered for `onError` that throws is not reported again, to avoid an endless loop.

## What an error carries

`code`
: What went wrong, as one of the strings in `SerialBrokerErrorCode`. Stable across versions: branch
on this.

`message`
: A description for developers. It may change in any release; never parse it.

`remediation`
: One sentence saying what to do, for every code. Suitable for a support log, and often for the
user.

`isRetryable`
: `true` when serial-broker is already recovering from the condition by itself. The status shows
the recovery; the application needs to do nothing. See [below](#retryable-errors).

`configName`
: The configuration the error concerns, where there is one.

`context`
: Structured detail specific to the code, such as `argumentName` or `bytesWritten`. The fields for
each code are listed below.

`cause`
: The underlying exception, where there was one. For errors that arose in another tab this is a
plain `Error` with the original name and message, because exceptions cannot cross between tabs
as they are.

`timestamp`
: Epoch milliseconds at which the error arose, in the tab where it arose.

An error from another tab is rebuilt in the receiving tab: `instanceof SerialBrokerError` holds for
it, and every field above is present. `toJSON()` gives a plain object with the same fields, for
sending an error to a logging service.

## Handling errors well

```ts
import { SerialBrokerError, SerialBrokerErrorCode } from 'serial-broker';

try {
  await SerialBroker.send('Scale', 'TARE\r\n');
} catch (error) {
  if (!(error instanceof SerialBrokerError)) throw error;

  switch (error.code) {
    case SerialBrokerErrorCode.OWNER_LOST_DURING_WRITE:
      // The one case that needs a decision only the application can make.
      break;
    default:
      showMessage(error.remediation);
  }
}
```

- Branch on `code`, never on `message`.
- Give every `switch` over codes a default branch. A later version may add a code, and an error
  with a code the application does not know is still an error, with a `remediation` to show.
- Do not show retryable errors as problems. The status tells the user that the connection is
  being restored.
- Decide what `OWNER_LOST_DURING_WRITE` means for each command; see
  [Commands that must not run twice](examples/advanced.md#commands-that-must-not-run-twice).

## Retryable errors

Four codes are retryable: `DEVICE_DISCONNECTED`, `OPEN_FAILED`, `OPEN_TIMEOUT` and `READ_FAILED`.
Each one ends a connection attempt or a connection, and the tab holding the port schedules the
next attempt as described in [Reconnecting](configuration.md#reconnecting). Only when the attempts
are used up does a non-retryable error follow: `RECONNECT_EXHAUSTED`.

A retryable code that repeats for a long time still says something: `OPEN_FAILED` over and over
usually means another program has the device open, or the adapter rejects the line settings.

## Every code

### Mistakes in the calling code

`INVALID_ARGUMENT`
: **Raised by** any method, for an argument that fails validation, including every option of
`setup()`, and by `send()` for a string when the configured `encoding` is not UTF-8.
**Context:** `argumentName` names the field, such as `options.serial.baudRate`; `expected` says
what it must be; `actualType` and, for simple values, `actualValue` say what it was.
**Do:** fix the call. This error never arises from anything outside the application's code.

`UNKNOWN_CONFIGURATION`
: **Raised by** `send()`, `subscribe()`, `getStatus()`, `requestAccess()` and the other methods
that take a name, when that name is not set up **in this tab**. A configuration set up in another
tab does not count. `release()` of a name that is not set up does nothing and raises nothing.
**Do:** call `setup()` in this tab first — every tab sets up the configurations it uses.

`CONFIGURATION_CONFLICT`
: **Raised by** `setup()` for a name already set up in this tab with a different device, baud rate,
data bits, stop bits, parity, flow control or buffer size. Other differences are ignored, and identical
options make the second `setup()` a no-op.
**Context:** `existing` and `requested` device filters.
**Do:** `release()` the configuration first, then set it up with the new options. See
[Restoring, releasing and forgetting](examples/all-features.md#restoring-releasing-and-forgetting)
for the typical case of a remembered configuration from an older version of the application.

`CONFIGURATION_RELEASED`
: **Raised** for writes still pending when their configuration is released in this tab, by
`release()`, `releaseAll()` or `dispose()`. A diagnostics observer raises it after `close()`.
Calls made after `dispose()` do not raise it: they start afresh, so a name raises
`UNKNOWN_CONFIGURATION` until it is set up again.
**Do:** nothing, if the release was intended. Otherwise set the configuration up again.

### The browser environment

`WEB_SERIAL_UNAVAILABLE`
: **Raised by** `setup()`, `send()`, `subscribe()`, `getStatus()`, `requestAccess()`, `restore()`
and `openDiagnostics()` when the browser has no Web Serial API: not a Chromium-based browser, not
a secure context, or disabled by policy. Each of these builds serial-broker's internal client if
there is none yet, and that is where the check happens. `exists()`, `names()`, `unsubscribe()`,
`release()` and `releaseAll()` build nothing while nothing is set up, and raise nothing. Also
delivered through `onError` when the browser refuses to open a port because of a permissions
policy.
**Do:** check `isSupported()` before `setup()`, and tell the user which browsers work. Nothing
can be done from the page itself.

`WEB_LOCKS_UNAVAILABLE`
: **Raised by** the same calls when the Web Locks API is missing. Every browser with Web Serial has
it, so this means a restricted context.
**Do:** as above.

`TRANSPORT_UNAVAILABLE`
: **Raised by** `setup()` when neither `SharedWorker` nor `BroadcastChannel` can be used — in some
privacy configurations, and in sandboxed iframes without `allow-same-origin`.
**Do:** run the application outside the restriction.

`BROKER_UNAVAILABLE`
: **Raised by** `setup()` when `transport: 'sharedworker'` is configured and the worker cannot be
created. **Delivered through `onError`** when the message bus reports a failure while running —
with `transport: 'sharedworker'`, also when the worker script fails to load. With the default
`'auto'`, a script that fails to load is replaced by a `BroadcastChannel` and raises nothing.
**Do:** check that `serial-broker.worker.js` is served from the application's origin, at the URL
every tab uses; see [The worker script](installing.md#the-worker-script).

### Permission

`PERMISSION_REQUIRED`
: **Raised by** `requestAccess()` in a tab that does not hold the port, while the device is not
connected. Only the tab holding the port can use the user's choice.
**Context:** `status`.
**Do:** in practice, show the button only in response to `awaiting-permission`, which is reported
in every tab; if this error occurs anyway, ask the user to try again. In a tab that does not hold
the port, `requestAccess()` while the device is connected resolves `true` without a prompt.

`PERMISSION_DENIED`
: **Not raised.** When the user closes the port picker without choosing — or no port in the picker
matches the device — `requestAccess()` resolves `false` instead, because that is a decision, not
a failure.
**Do:** leave the button in place so the user can try again.

`USER_GESTURE_REQUIRED`
: **Raised by** `requestAccess()` when it is not called in response to a click or key press. The
most common cause is an `await` before the call, which uses up the gesture.
**Do:** call `requestAccess()` as the first thing in the event handler.

`DEVICE_MISMATCH`
: **Raised by** `requestAccess()` when the chosen port's USB IDs differ from the configured ones.
**Context:** `expectedVendorId`, `expectedProductId`, `actualVendorId`, `actualProductId`.
**Do:** compare the IDs. An adapter from a different production run sometimes reports different
ones; configure the IDs the device really reports.

### The connection

These are delivered through `onError`, in every tab.

`OPEN_FAILED` (retryable)
: **Arises** when the browser rejects opening the port: another program has it open, the adapter
rejects the line settings, or the port is in a state it cannot be opened from.
**Context:** `domExceptionName`, the name of the browser's exception.
**Do:** nothing for a single occurrence. When it repeats, close terminal programs and other
tools using the device, and check the line settings.

`OPEN_TIMEOUT` (retryable)
: **Arises** when opening or closing the port does not finish within `openTimeoutMs`. Usually a
driver that has stopped responding.
**Do:** when it repeats, unplug the device and plug it in again.

`DEVICE_DISCONNECTED` (retryable)
: **Arises** when the device is unplugged or switched off, or ends the connection.
**Do:** nothing. The connection returns when the device does; the status shows `reconnecting`.

`READ_FAILED` (retryable)
: **Arises** when reading from the device fails for a reason other than a disconnect — often a
framing or parity error, or an unreliable cable.
**Do:** when it repeats, check the line settings, the cable and the adapter.

`RECONNECT_EXHAUSTED`
: **Arises** when `maxAttempts` attempts have failed. The status becomes `failed`. With the default,
`maxAttempts: Infinity`, it never arises.
**Context:** `attempts`, and `reason` for the last loss; `cause` is the last error.
**Do:** show the device as unavailable. The configuration revives by itself when the browser
reports the device plugged in again. To try again sooner, `release()` the configuration and set
it up again.

### Writing

These reject the `send()` call they belong to, in the tab that issued it.

`WRITE_TIMEOUT`
: **Arises** in two ways, told apart by `context`:

- The whole `send()` — waiting for a connection, reaching the tab holding the port, and the
  device accepting the bytes — took longer than `writeTimeoutMs`. **Context:** `started`: `false`
  if the write never began, so the device received nothing; `true` if it had begun and may still
  complete after the rejection.
- The device did not accept a chunk within `writeTimeoutMs`, typically because of flow control.
  **Context:** `bytesWritten` of `byteLength`. The tab holding the port also treats the
  connection as broken and reconnects.

**Do:** when `started` is `false`, the write can be sent again. Otherwise treat it like
`OWNER_LOST_DURING_WRITE`. If timeouts are frequent while the status is `open`, check
`flowControl` and whether the device is ready to receive.

`WRITE_FAILED`
: **Arises** when the device or the browser rejects the write.
**Context:** `bytesWritten` of `byteLength` — how much was handed over before the failure. The tab
holding the port reconnects.
**Do:** decide, for the command, whether a partial write can be repeated.

`NOT_CONNECTED`
: **Arises** when the connection was lost in the moment between a write being accepted and being
handed to the device. Nothing was written.
**Context:** `status`.
**Do:** send again, or wait for `open` first.

`OWNER_LOST_DURING_WRITE`
: **Arises** when the tab holding the port went away while the write was being written. Whether the
device received the bytes, some of them, or none, cannot be known. serial-broker never repeats
such a write.
**Context:** `byteLength`.
**Do:** repeat the command only if doing so is harmless for the device, or after checking its
state. See
[Commands that must not run twice](examples/advanced.md#commands-that-must-not-run-twice).

### Coordination between tabs

`PROTOCOL_VERSION_MISMATCH`
: **Delivered through `onError`** in a tab that learns of a tab on another version of serial-broker's
message protocol, once per version. Every tab announces its version when it sets up its first
configuration, and answers the announcements of tabs on other versions; see
[Tabs running different versions](shared-ports.md#tabs-running-different-versions).
**Context:** `theirVersion`.
**Do:** reload every tab of the application.

A message from another tab that cannot be read raises no error: it is dropped and logged as
`client.malformed-message`.

### Remembering configurations

These are delivered through `onError` in the tab where they arose.

`STORAGE_UNAVAILABLE`
: **Arises** when a read or write to `localStorage` fails, for instance because its quota is used
up. Where `localStorage` cannot be used at all — some private windows and sandboxed iframes —
serial-broker keeps configurations in memory for the lifetime of the page and reports nothing.
**Context:** `operation`: `read`, `write` or `clear`.
**Do:** nothing is needed for the current page. Configurations will not be restored after a
reload, so the application should set them up itself.

`STORAGE_CORRUPT`
: **Arises** in `restore()` when the remembered configurations cannot be read, or one of them is no
longer valid — for example after an application update changed what it stores. The unreadable
entries are discarded.
**Do:** nothing. Set the configuration up again, and it is remembered afresh.

### serial-broker itself

`LISTENER_THREW`
: **Delivered through `onError`** in the tab whose listener threw. The other listeners still
received the event, and other tabs are not told.
**Context:** `event`, the event the listener was registered for; `cause` is the exception.
**Do:** fix the listener.

`INTERNAL_INVARIANT`
: **Arises** when serial-broker detects that its own state is inconsistent. This is a bug in
serial-broker.
**Do:** report it with `context` and the steps that led to it.

`UNKNOWN`
: **Delivered through `onError`** when another tab reports an error with a code this version of
serial-broker does not know. That tab runs a later version, to which the code was added.
**Context:** `reportedCode`, the code the other tab reported, next to that error's own context. The
message and the remediation are the other tab's.
**Do:** reload every tab of the application, so that all of them run the same version.
