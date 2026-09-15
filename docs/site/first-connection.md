# First connection

This tutorial connects to a device, shows what it sends, sends it a command, and handles the one
thing an application has to do by hand: asking the user for permission the first time. It takes
about ten minutes.

You need a browser and a page that meet the [requirements](installing.md#requirements), with
serial-broker [installed](installing.md), and a USB-serial device. A cheap adapter with its TX and
RX pins connected to each other is ideal: everything you send comes straight back.

To try a device before writing any code, use
[the debugging surface](#the-shortcut-the-debugging-surface) instead.

## 1. Set up a configuration

A **configuration** is a name for a device and the settings to open it with. Everything else in the
API addresses it by that name.

```ts
import { SerialBroker } from 'serial-broker';

await SerialBroker.setup('Adapter', {
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});
```

`setup()` resolves as soon as the configuration is registered. It does not wait for the port to
open, because that may need the user — see step 3.

Call `setup()` on every page load. Calling it again with the same options does nothing to a working
configuration, so there is no need to check first.

## 2. Watch the status and what the device sends

```ts
SerialBroker.subscribe('Adapter', 'onStatusChange', (event) => {
  statusLabel.textContent = event.status;
});

SerialBroker.subscribe('Adapter', 'onReceive', (event) => {
  output.textContent += event.text ?? '';
});
```

Every tab receives these events, whichever tab holds the port. `event.data` always holds the raw
bytes; `event.text` is there because `decodeText` is on. What the device sends is collected until
the line has been quiet for a moment, so a short answer usually arrives as one event — but an event
is not a message; see [Receiving](guarantees.md#receiving).

A new `onStatusChange` listener is told the current status once, right after `subscribe()` returns,
so the label is right from the start without a separate `getStatus()`.

## 3. Ask for permission, once

The first time, nobody has chosen which port the device is, and the browser shows its port picker
only in response to a click. The status becomes `awaiting-permission` and stays there until you ask:

```ts
connectButton.addEventListener('click', () => {
  SerialBroker.requestAccess('Adapter').then(
    (granted) => {
      connectButton.hidden = granted;
    },
    (error: unknown) => {
      output.textContent += `\n[${String(error)}]\n`;
    },
  );
});

SerialBroker.subscribe('Adapter', 'onStatusChange', (event) => {
  connectButton.hidden = event.status !== 'awaiting-permission';
});
```

Call `requestAccess()` **directly** in the click handler. An `await` before it uses up the click,
and the browser refuses to show the picker (`USER_GESTURE_REQUIRED`). `requestAccess()` resolves
`false` when the user closes the picker without choosing.

Every tab shows `awaiting-permission`, and the button works in each of them: the permission belongs to
the origin, and the tab holding the port opens the port the user chose. Only a tab `queued` under
`maxTabs`, or one that withdrew, rejects with `PERMISSION_REQUIRED`, so show the error rather than dropping it. The rules
are in [Permission, and remembering devices](shared-ports.md#permission-and-remembering-devices).

Once the user has chosen the port, the browser remembers the choice for your origin. On every later
visit, `setup()` finds the port and opens it with no prompt.

### Letting the user choose, or naming the device

The configuration in step 1 names no device, so it is in **auto mode**: the picker shows every
port, and the port the user picks becomes the configuration's device — its USB IDs, or the fact that
it has none. The choice is remembered with the configuration and shared with every tab that sets the
name up without a device. Until the user has chosen, nothing is opened, however many ports the
browser has granted.

To change the device later — another adapter after a swap on the line — call
`SerialBroker.requestAccess('Adapter', { chooseAgain: true })` from a click, in any tab. The picker
shows every port again, and the port chosen replaces the device in every tab and in what is
remembered; the tab holding the port closes the old one and opens the new one.

When you know the device, name it by its USB IDs instead:

```ts
await SerialBroker.setup('Adapter', {
  device: { vendorId: 0x1a86, productId: 0x7523 },
  serial: { baudRate: 9600 },
});
```

The picker then offers only devices with these IDs, and a port the browser has already granted for
them opens without asking. Choosing between the two, and the shapes for ports without USB IDs, is
described under [`device`](configuration.md#device).

### Finding a device's USB IDs

- **Windows:** Device Manager, the device's _Properties_, _Details_, _Hardware Ids_:
  `USB\VID_1A86&PID_7523` means `vendorId: 0x1a86, productId: 0x7523`.
- **Linux:** `lsusb` prints `ID 1a86:7523`.
- **Any system:** connect once in auto mode; `getStatus()` then reports `vendorId` and `productId`,
  and the [debugging surface](diagnostics.md#the-debugging-surface) shows them in its _Settings_
  panel.

A built-in RS-232 interface, a virtual COM port or a Bluetooth serial port has no USB IDs. Auto mode
handles it; so do `{ nonUsb: true }` and `{ any: true }`.

## 4. Send

```ts
await SerialBroker.send('Adapter', 'HELLO\r\n');
await SerialBroker.send('Adapter', new Uint8Array([0x02, 0x41, 0x03]));
```

Nothing is appended to what you send: if the device expects a line ending, include it. The promise
resolves once the browser has taken the bytes for the port, not once the device has received them;
see [What a resolved send means](guarantees.md#what-a-resolved-send-means). If the port is not open
yet, `send()` waits for it, up to `connection.writeTimeoutMs`, and then rejects with
`WRITE_TIMEOUT`.

## 5. Open a second tab

Open the same page in another tab. It sets up the same configuration, receives the same data, and
can send as well. Close the first tab: the second takes over the port within moments.

## 6. Handle errors

Every failure is a `SerialBrokerError` with a stable `code` and a `remediation` sentence:

```ts
import { SerialBrokerError } from 'serial-broker';

try {
  await SerialBroker.send('Adapter', 'CUT\r\n');
} catch (error) {
  if (error instanceof SerialBrokerError) {
    console.error(error.code, error.remediation);
  }
}
```

Errors that are not the answer to a call — a device that was unplugged, a tab that went away — are
reported through the `onError` event. Every code is described in [Errors](errors.md).

## 7. Release

```ts
await SerialBroker.release('Adapter');
```

This tab stops using the configuration, and its listeners for the name are removed. Other tabs that
still use it keep the port open. The browser's permission for the device is kept, so a later
`setup()` needs no prompt; `release('Adapter', { forgetDevice: true })` revokes it.

## The shortcut: the debugging surface

The package ships a page in `dist/debug/` that connects to a device with no code at all: serve
`dist/`, open `/debug/`, press **Choose a device…**, enter a name and the line settings, and
**Connect** opens the port picker. Send a line on the _Traffic_ panel to see the device answer, and
copy the settings into your own `setup()` call. How to serve it, and whether to, is described in
[The debugging surface](diagnostics.md#the-debugging-surface).

## Next

- [Guarantees](guarantees.md) says what your application can rely on.
- [Examples](examples/index.md) goes from this page to a complete application.
- [Configuration](configuration.md) describes every option.
- [Compared with Web Serial](tasks.md) shows what each common task takes with and without
  serial-broker.
