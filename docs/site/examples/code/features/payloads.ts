import { SerialBroker, type Unsubscribe } from 'serial-broker';

/** Sends text, bytes, and a structured binary frame. */
export async function sendPayloads(name: string): Promise<void> {
  // Text is encoded as UTF-8. Nothing is appended: include the line ending the device expects.
  await SerialBroker.send(name, 'PRINT Grüße\r\n');

  // Bytes pass through untouched: STX, 'A', ETX.
  await SerialBroker.send(name, new Uint8Array([0x02, 0x41, 0x03]));

  // Any BufferSource works, such as a DataView over a buffer the application filled.
  const frame = new DataView(new ArrayBuffer(3));
  frame.setUint8(0, 0x10);
  frame.setUint16(1, 1500);
  await SerialBroker.send(name, frame);
}

/** Logs every received chunk as hex. */
export function logReceivedBytes(name: string): Unsubscribe {
  return SerialBroker.subscribe(name, 'onReceive', (event) => {
    const hex = [...event.data].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const time = new Date(event.timestamp).toISOString();
    console.log(`${time}  ${String(event.data.length)} bytes  ${hex}`);
  });
}
