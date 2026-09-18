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

const showStatus = (status: string): void => {
  statusLabel.textContent = status;
  connectButton.hidden = status !== 'awaiting-permission';
};

// No `device`: the configuration takes it from the port the user picks, and remembers it. Name
// one with `device: { vendorId, productId }` to filter the picker to a known USB device.
await SerialBroker.setup(DEVICE, {
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
});

SerialBroker.subscribe(DEVICE, 'onStatusChange', (event) => {
  showStatus(event.status);
});
SerialBroker.subscribe(DEVICE, 'onReceive', (event) => {
  output.textContent += event.text ?? '';
});

connectButton.addEventListener('click', () => {
  // Called directly in the click, which counts as a gesture for a few seconds only. It can still fail -
  // in a tab queued under maxTabs, for one - so the failure is shown rather than dropped.
  SerialBroker.requestAccess(DEVICE).catch((error: unknown) => {
    output.textContent += `\n[${String(error)}]\n`;
  });
});

sendForm.addEventListener('submit', (event) => {
  event.preventDefault();
  SerialBroker.send(DEVICE, `${lineInput.value}\r\n`).catch((error: unknown) => {
    output.textContent += `\n[not sent: ${String(error)}]\n`;
  });
  lineInput.value = '';
});
