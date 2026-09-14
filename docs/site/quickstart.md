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

await SerialBroker.setup('Adapter', {
  device: { vendorId: 0x1a86, productId: 0x7523 },
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});
```

`vendorId` and `productId` identify the kind of USB device. On Windows they are in Device Manager
under the device's _Hardware Ids_ (`VID_1A86&PID_7523`); on Linux, `lsusb` prints them.

If you would rather not look them up, the [debugging surface](diagnostics.md) reads them off the
device: serve `dist/`, open `/debug/`, press **Choose a device…**, and pick your port. It connects
to it there and then, and its _Settings_ panel shows the values for the call above — including the
ones for a port that has no USB IDs at all.

`setup()` resolves as soon as the configuration is registered. It does not wait for the port to
open, because that may need the user — see step 3.

Call `setup()` on every page load. Calling it again with the same options does nothing, so there
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

The first time, the browser has not been told which port the device is, and it will only show its
port picker in response to a click. The status becomes `awaiting-permission` and stays there until
you ask:

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
and the browser will refuse to show the picker.

Once the user has chosen the port, the browser remembers the choice for your origin. On every
later visit, `setup()` finds the port and opens it with no prompt.

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

- [How shared ports behave](shared-ports.md) explains what happens when tabs and devices come and
  go, and what your application can rely on.
- [Examples](examples/index.md) goes from this minimal page to a complete application.
- [Configuration](configuration.md) describes every option.
