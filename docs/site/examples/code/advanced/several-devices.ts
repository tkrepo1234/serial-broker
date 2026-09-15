import { SerialBroker } from 'serial-broker';

import { onLines } from '../features/lines.js';

/**
 * A scale and a label printer, driven from the same tabs.
 *
 * Each configuration is independent: its own ownership lock, its own connection, its own
 * reconnection. The scale can be held by one tab and the printer by another, and the application
 * cannot tell and does not need to.
 */
export async function weighAndLabel(): Promise<() => Promise<void>> {
  await SerialBroker.setup('Scale', {
    device: { vendorId: 0x0403, productId: 0x6001 },
    serial: { baudRate: 9600 },
    encoding: { decodeText: true },
  });
  await SerialBroker.setup('Printer', {
    device: { vendorId: 0x0dd4, productId: 0x0205 },
    serial: { baudRate: 115_200, flowControl: 'hardware' },
  });

  const stopListening = onLines('Scale', (line) => {
    // "ST,GS,+  12.345kg": stable, gross weight.
    if (line.startsWith('ST,')) {
      const weight = line.slice(6).trim();
      SerialBroker.send('Printer', `^XA^FO50,50^A0N,60^FD${weight}^FS^XZ`).catch(
        (error: unknown) => {
          console.error('The label was not printed', error);
        },
      );
    }
  });

  return async () => {
    stopListening();
    await SerialBroker.release('Scale');
    await SerialBroker.release('Printer');
  };
}
