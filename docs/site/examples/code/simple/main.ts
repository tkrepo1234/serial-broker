import { SerialBroker } from 'serial-broker';

const DEVICE = 'Adapter';

const statusLabel = document.querySelector<HTMLElement>('#status');
const connectButton = document.querySelector<HTMLButtonElement>('#connect');
const sendForm = document.querySelector<HTMLFormElement>('#send');
const lineInput = document.querySelector<HTMLInputElement>('#line');
const output = document.querySelector<HTMLPreElement>('#output');
if (!statusLabel || !connectButton || !sendForm || !lineInput || !output) {
  throw new Error('The page is missing an element this script needs.');
}

function showStatus(status: string): void {
  if (statusLabel && connectButton) {
    statusLabel.textContent = status;
    connectButton.hidden = status !== 'awaiting-permission';
  }
}

await SerialBroker.setup(DEVICE, {
  device: { vendorId: 0x1a86, productId: 0x7523 },
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});

SerialBroker.subscribe(DEVICE, 'onStatusChange', (event) => {
  showStatus(event.status);
});
SerialBroker.subscribe(DEVICE, 'onReceive', (event) => {
  output.textContent += event.text ?? '';
});
// The status may already have changed before the listener was registered.
showStatus(SerialBroker.getStatus(DEVICE).status);

connectButton.addEventListener('click', () => {
  // Called directly in the click: an `await` before it would use up the click.
  void SerialBroker.requestAccess(DEVICE);
});

sendForm.addEventListener('submit', (event) => {
  event.preventDefault();
  SerialBroker.send(DEVICE, `${lineInput.value}\r\n`).catch((error: unknown) => {
    output.textContent += `\n[not sent: ${String(error)}]\n`;
  });
  lineInput.value = '';
});
