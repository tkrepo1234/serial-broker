# Quickstart

This tutorial connects to a device, shows what it sends, sends it a command, and handles the one
thing an application has to do by hand: asking the user for permission the first time. It takes
about ten minutes.

You need a Chromium-based browser, a page served over `localhost` or HTTPS, and a USB-serial
device. A cheap CH340 adapter with its TX and RX pins connected to each other is ideal: everything
you send comes straight back.

## 1. Set up a configuration

A **configuration** is a name for a device and the settings to open it with. Everything else in
the API addresses it by that name.

```ts
import { SerialBroker } from 'serial-broker';

await SerialBroker.restore();
await SerialBroker.setup('Adapter', {
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});
```

No device is named: the configuration takes it from the port the user picks in the browser's
picker the first time (step 3), remembers it, and shares it with the other tabs. `restore()` brings
that choice back on a later visit; without it, `setup()` asks the user again. To name the
device instead, pass `device: { vendorId: 0x1a86, productId: 0x7523 }`: the USB IDs identify the
kind of device, the picker is then filtered to it, and nothing else is ever offered. On Windows the
IDs are in Device Manager under the device's _Hardware Ids_ (`VID_1A86&PID_7523`); on Linux,
`lsusb` prints them; and the [debugging surface](diagnostics.md) shows them in its _Settings_
panel once a device has been chosen there.

`setup()` resolves as soon as the configuration is registered. It does not wait for the port to
open, because that may need the user — see step 3.

Call both on every page load. Calling `setup()` again with the same options does nothing, so there
is no need to check first.

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
bytes; `event.text` is there because `decodeText` is enabled.

## 3. Ask for permission, once

The first time, nobody has chosen which port the device is, and the browser will only show its
port picker in response to a click. The status becomes `awaiting-permission` and stays there until
you ask. The picker is unfiltered, and the port the user picks becomes the configuration's device,
for this visit, every later one, and every tab:

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
```

Call `requestAccess()` **directly** in the click handler. An `await` before it uses up the click,
and the browser will refuse to show the picker. Every tab shows `awaiting-permission`, but only the
tab holding the port can ask; in the others `requestAccess()` rejects with `PERMISSION_REQUIRED`, so
show the error rather than dropping it.

Once the user has chosen the port, the browser remembers the choice for your origin. On every
later visit, `restore()` and `setup()` find the port and open it with no prompt.

```ts
const { status } = SerialBroker.getStatus('Adapter');
connectButton.hidden = status !== 'awaiting-permission';
```

## 4. Send

```ts
await SerialBroker.send('Adapter', 'HELLO\r\n');
await SerialBroker.send('Adapter', new Uint8Array([0x02, 0x41, 0x03]));
```

Nothing is appended to what you send: if the device expects a line ending, include it. The
promise resolves once the bytes have been handed to the device.

If the port is not open yet, `send()` waits for it — up to `connection.writeTimeoutMs`, five
seconds by default — and then rejects with `WRITE_TIMEOUT`.

## 5. Open a second tab

Open the same page in another tab. It sets up the same configuration, receives the same data, and
can send as well. Close the first tab: the second takes over the port within moments.

## 6. Handle errors

Every failure is a `SerialBrokerError` with a stable `code`:

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
reported through the `onError` event in every tab.

## 7. Release

```ts
await SerialBroker.release('Adapter');
```

This tab stops using the configuration. Other tabs that still use it keep the port open. The
browser's permission for the device is kept, so a later `setup()` needs no prompt.

## Next

- [Tasks, counted](tasks.md) shows the code for each common task, and what it takes with Web Serial
  alone.
- [How shared ports behave](shared-ports.md) explains what happens when tabs and devices come and
  go, and what your application can rely on.
- [Examples](examples/index.md) goes from this minimal page to a complete application.
- [Configuration](configuration.md) describes every option.
