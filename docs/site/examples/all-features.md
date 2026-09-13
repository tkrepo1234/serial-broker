# All features

One capability per section, each a module you can lift into an application on its own.

## Asking for permission

The browser only shows its port picker in response to a click, and only needs to once per device
and origin. Show the button while — and only while — the status is `awaiting-permission`:

```{literalinclude} code/features/permission.ts
:language: ts
```

Only the tab that holds the port can ask. In any other tab `requestAccess()` rejects with
`PERMISSION_REQUIRED` while the device is still missing; see
[Permission, and remembering devices](../shared-ports.md#permission-and-remembering-devices).

## Showing the status

Every tab reports the same status. Treat the list of statuses as open-ended: a later version may
add one, and the application should show it rather than fail.

```{literalinclude} code/features/status.ts
:language: ts
```

## Sending text and bytes

```{literalinclude} code/features/payloads.ts
:language: ts
```

`send()` resolves once the bytes have been handed to the device. Writes from one tab arrive in the
order they were issued; writes from different tabs have no defined order.

## Reading lines

A chunk from the device is an arbitrary piece of the byte stream. With `decodeText` enabled, a
character split across two chunks is decoded correctly; turning the text into lines is up to the
application:

```{literalinclude} code/features/lines.ts
:language: ts
```

## Handling errors

Failures reach the application in two ways: as a rejected promise from the call that failed, and
through the `onError` event for everything else.

```{literalinclude} code/features/errors.ts
:language: ts
```

`isRetryable` is `true` for failures serial-broker is already recovering from — a device that was
unplugged, a port that did not open. The status shows the recovery; the application need not act.
Every code is described in [Errors](../errors.md).

## Restoring, releasing and forgetting

```{literalinclude} code/features/lifecycle.ts
:language: ts
```

`restore()` sets up every configuration this origin remembers. `release()` stops using a
configuration in one tab and keeps the browser's permission; `forgetDevice: true` revokes it, so
the next setup asks the user again.

## Using the device from one window at a time

With `maxTabs: 1`, one tab uses the configuration and every other tab waits with the status
`queued`. The tab that has waited longest takes over when the one using it is closed, crashes, or
releases the configuration:

```{literalinclude} code/features/exclusive.ts
:language: ts
```

Every tab has to pass the same `maxTabs`. See
[Limiting how many tabs use a port](../shared-ports.md#limiting-how-many-tabs-use-a-port).

## Library-wide settings, logging, and ports without USB identity

```{literalinclude} code/features/setup-options.ts
:language: ts
```

`configure()` has to run before the first `setup()`. A logger receives structured records from
every part of serial-broker; see [Diagnostics](../diagnostics.md) for what is logged at which
level. `device: { any: true }` accepts whatever port the user granted, for ports that report no
USB vendor or product ID.
