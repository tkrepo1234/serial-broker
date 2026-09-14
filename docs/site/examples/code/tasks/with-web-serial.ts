// The same tasks with the Web Serial API alone, in one tab, for the comparison in
// docs/site/tasks.md. Each is included on its own, between its two markers.

// [connect]
export async function connectAndPrint(output: HTMLElement): Promise<void> {
  const ports = await navigator.serial.getPorts();
  const port = ports.find((candidate) => {
    const info = candidate.getInfo();
    return info.usbVendorId === 0x0403 && info.usbProductId === 0x6001;
  });
  if (port === undefined) {
    return; // Not granted yet: see "Asking for permission".
  }
  await port.open({ baudRate: 9600 });
  if (port.readable === null) {
    return;
  }
  const reader = port.readable.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      output.textContent += decoder.decode(value, { stream: true });
    }
  } finally {
    // The loop ends when the device goes away, too. Reconnecting is up to the application.
    reader.releaseLock();
  }
}
// [/connect]

// [send]
export async function tare(port: SerialPort): Promise<void> {
  if (port.writable === null) {
    throw new Error('The port is not open.');
  }
  // Throws while another write holds the writer: concurrent writes need a queue of their own.
  const writer = port.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode('TARE\r\n'));
  } finally {
    writer.releaseLock();
  }
}
// [/send]

// [status]
export function showStatus(label: HTMLElement): void {
  // There is no status to read: the application keeps its own, from what open(), the read loop and
  // these two events tell it.
  navigator.serial.addEventListener('connect', () => {
    label.textContent = 'plugged in';
  });
  navigator.serial.addEventListener('disconnect', () => {
    label.textContent = 'unplugged';
  });
}
// [/status]

// [permission]
export function offerDeviceChoice(
  button: HTMLButtonElement,
  open: (port: SerialPort) => Promise<void>,
): void {
  button.addEventListener('click', () => {
    navigator.serial
      .requestPort({ filters: [{ usbVendorId: 0x0403, usbProductId: 0x6001 }] })
      .then(open, (error: unknown) => {
        // A NotFoundError when the user closed the picker without choosing.
        console.error(error);
      });
  });
}
// [/permission]

// [release]
export async function stopUsingScale(
  port: SerialPort,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  readLoop: Promise<void>,
  forgetDevice: boolean,
): Promise<void> {
  await reader.cancel(); // ends the read loop, which releases the reader's lock
  await readLoop;
  await port.close(); // rejects while a stream is still locked
  if (forgetDevice) {
    await port.forget();
  }
}
// [/release]

// [restore]
export async function startUp(): Promise<SerialPort | undefined> {
  const saved = localStorage.getItem('scale');
  if (saved === null) {
    return undefined;
  }
  const { vendorId, productId, baudRate } = JSON.parse(saved) as Record<string, number>;
  const ports = await navigator.serial.getPorts();
  const port = ports.find((candidate) => {
    const info = candidate.getInfo();
    return info.usbVendorId === vendorId && info.usbProductId === productId;
  });
  await port?.open({ baudRate: baudRate ?? 9600 });
  return port;
}
// [/restore]

// [exclusive]
export async function operateAlone(
  port: SerialPort,
  work: (port: SerialPort) => Promise<void>,
): Promise<void> {
  // Every tab asks for the same lock and waits in line; the browser lets go of it when a tab
  // closes or crashes, and closes that tab's port.
  await navigator.locks.request('press', async () => {
    await port.open({ baudRate: 115_200 });
    try {
      await work(port);
    } finally {
      await port.close();
    }
  });
}
// [/exclusive]
