import { SerialBroker, type Unsubscribe } from 'serial-broker';

// Each task below is included on its own by docs/site/tasks.md, between its two markers.

// [connect]
export async function connectAndPrint(output: HTMLElement): Promise<void> {
  await SerialBroker.setup('Scale', {
    device: { vendorId: 0x0403, productId: 0x6001 },
    serial: { baudRate: 9600 },
    encoding: { decodeText: true },
  });
  SerialBroker.subscribe('Scale', 'onReceive', (event) => {
    output.textContent += event.text ?? '';
  });
}
// [/connect]

// [send]
export async function tare(): Promise<void> {
  await SerialBroker.send('Scale', 'TARE\r\n');
}
// [/send]

// [status]
export function showStatus(label: HTMLElement): Unsubscribe {
  const stop = SerialBroker.subscribe('Scale', 'onStatusChange', (event) => {
    label.textContent = event.status;
  });
  label.textContent = SerialBroker.getStatus('Scale').status;
  return stop;
}
// [/status]

// [permission]
export function offerDeviceChoice(button: HTMLButtonElement): void {
  SerialBroker.subscribe('Scale', 'onStatusChange', (event) => {
    button.hidden = event.status !== 'awaiting-permission';
  });
  button.hidden = SerialBroker.getStatus('Scale').status !== 'awaiting-permission';
  button.addEventListener('click', () => {
    SerialBroker.requestAccess('Scale').catch((error: unknown) => {
      console.error(error);
    });
  });
}
// [/permission]

// [release]
export async function stopUsingScale(forgetDevice: boolean): Promise<void> {
  await SerialBroker.release('Scale', { forgetDevice });
}
// [/release]

// [restore]
export async function startUp(): Promise<void> {
  await SerialBroker.restore();
  await SerialBroker.setup('Scale', { serial: { baudRate: 9600 } });
}
// [/restore]

// [exclusive]
export async function operateAlone(): Promise<void> {
  await SerialBroker.setup('Press', {
    device: { vendorId: 0x0403, productId: 0x6001 },
    serial: { baudRate: 115_200 },
    maxTabs: 1,
  });
}
// [/exclusive]
