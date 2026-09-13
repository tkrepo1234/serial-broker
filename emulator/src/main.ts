/**
 * Runs the emulated serial device and lets an operator drive it from the terminal.
 *
 *     npm run emulator
 *     npm run emulator -- --vendor-id 0x1209 --product-id 0x0001 --no-attach
 *
 * See emulator/README.md for the one-time setup and how this maps onto the manual test plan.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { CdcAcmDevice } from './cdc-acm-device.ts';
import type { DeviceEvent, DeviceStatus } from './cdc-acm-device.ts';
import { describeBytes, parseEscapedText } from './payload-text.ts';
import { BUS_ID, UsbipServer } from './usbip-server.ts';
import type { ServerEvent } from './usbip-server.ts';

const DEFAULT_USBIP_PATH = 'C:\\Program Files\\USBip\\usbip.exe';

/** pid.codes reserves 0x1209:0x0001 for private testing, so it cannot collide with a product. */
const DEFAULT_VENDOR_ID = 0x1209;
const DEFAULT_PRODUCT_ID = 0x0001;

const COMMANDS = `Commands:
  plug          make the device available again and attach it (usbip.exe attach)
  unplug        pull the cable: close the connection and refuse re-import until "plug"
  attach        run usbip.exe attach, without changing whether the device is plugged in
  detach        run usbip.exe detach for the port this emulator attached
  hang          stop accepting writes; they stay in flight until "resume"
  resume        accept the held writes, in order, and every write after
  echo          return every byte written (the default, like TX and RX bridged)
  silent        accept writes and answer nothing
  chunk <n>     return at most n bytes per read ("chunk off" lifts the cap)
  send <text>   send bytes to the host; escapes \\r \\n \\t \\\\ \\xHH
  status        show the device and connection state
  help          show this list
  quit          stop the emulator`;

const USAGE = `Usage: node emulator/src/main.ts [options]

Options:
  --host <address>      listen address (default 127.0.0.1)
  --port <number>       listen port (default 3240)
  --vendor-id <hex>     USB vendor ID (default 0x1209)
  --product-id <hex>    USB product ID (default 0x0001)
  --usbip <path>        usbip.exe from usbip-win2 (default ${DEFAULT_USBIP_PATH})
  --no-attach           do not run usbip.exe attach on start
  --help                show this text

${COMMANDS}`;

const { values: options } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '3240' },
    'vendor-id': { type: 'string', default: `0x${DEFAULT_VENDOR_ID.toString(16)}` },
    'product-id': { type: 'string', default: `0x${DEFAULT_PRODUCT_ID.toString(16)}` },
    usbip: { type: 'string', default: DEFAULT_USBIP_PATH },
    'no-attach': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (options.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

const device = new CdcAcmDevice(
  {
    vendorId: parseId(options['vendor-id'], '--vendor-id'),
    productId: parseId(options['product-id'], '--product-id'),
    manufacturer: 'serial-broker',
    product: 'serial-broker emulated device',
    serialNumber: 'EMULATOR-0001',
  },
  (event) => {
    log(describeDeviceEvent(event));
  },
);
const server = new UsbipServer(
  device,
  { host: options.host, port: parseId(options.port, '--port') },
  (event) => {
    log(describeServerEvent(event));
  },
);

let attachedPort: string | undefined;

await server.listen();
log(
  `device ${hex4(device.identity.vendorId)}:${hex4(device.identity.productId)}, bus ID ${BUS_ID}`,
);
if (!existsSync(options.usbip)) {
  log(`usbip.exe not found at ${options.usbip}.`);
  log('Install usbip-win2 (see emulator/README.md) or pass --usbip, then type "attach".');
} else if (!options['no-attach']) {
  runUsbip(['attach', '-r', options.host, '-b', BUS_ID]);
}
log('Type "help" for commands.');

const terminal = createInterface({ input: process.stdin, output: process.stdout });
terminal.on('line', (line) => {
  const [command = '', ...rest] = line.trim().split(' ');
  handleCommand(command, rest.join(' '));
});
terminal.on('close', () => {
  void shutDown();
});

function handleCommand(command: string, argument: string): void {
  switch (command) {
    case '':
      return;
    case 'plug':
      server.plug();
      runUsbip(['attach', '-r', options.host, '-b', BUS_ID]);
      return;
    case 'unplug':
      server.unplug();
      log('unplugged; "plug" to bring it back');
      return;
    case 'attach':
      runUsbip(['attach', '-r', options.host, '-b', BUS_ID]);
      return;
    case 'detach':
      if (attachedPort === undefined) {
        log('this emulator has not attached a port; run "usbip.exe port" to find one');
        return;
      }
      runUsbip(['detach', '-p', attachedPort]);
      return;
    case 'hang':
      device.hang();
      log('hung: writes stay in flight until "resume"');
      return;
    case 'resume':
      device.resume();
      log('resumed');
      return;
    case 'echo':
    case 'silent':
      device.setBehaviour(command);
      log(`behaviour: ${command}`);
      return;
    case 'chunk':
      setChunk(argument);
      return;
    case 'send':
      send(argument);
      return;
    case 'status':
      log(describeStatus(device.status()));
      return;
    case 'help':
      process.stdout.write(`${COMMANDS}\n`);
      return;
    case 'quit':
      terminal.close();
      return;
    default:
      log(`unknown command "${command}"; type "help"`);
  }
}

function setChunk(argument: string): void {
  if (argument === 'off') {
    device.setMaxChunkBytes(undefined);
    log('reads are no longer capped');
    return;
  }
  const bytes = Number(argument);
  if (!Number.isInteger(bytes) || bytes < 1) {
    log('chunk needs a positive byte count, or "off"');
    return;
  }
  device.setMaxChunkBytes(bytes);
  log(`reads capped at ${String(bytes)} bytes`);
}

function send(argument: string): void {
  try {
    device.sendToHost(parseEscapedText(argument));
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
  }
}

function runUsbip(args: readonly string[]): void {
  log(`usbip.exe ${args.join(' ')}`);
  execFile(options.usbip, args, { windowsHide: true }, (error, stdout, stderr) => {
    const output = `${stdout}${stderr}`.trim();
    if (output !== '') {
      log(`usbip: ${output}`);
    }
    if (error !== null && output === '') {
      log(`usbip: ${error.message}`);
    }
    const attached = /attached to port (\d+)/.exec(output);
    if (attached?.[1] !== undefined) {
      attachedPort = attached[1];
    }
  });
}

async function shutDown(): Promise<void> {
  log('stopping');
  await server.close();
  process.exit(0);
}

function describeDeviceEvent(event: DeviceEvent): string {
  switch (event.kind) {
    case 'configured':
      return `configured (configuration ${String(event.configurationValue)})`;
    case 'line-coding': {
      const { baudRate, dataBits, parity, stopBits } = event.lineCoding;
      return `line coding ${String(baudRate)} baud, ${String(dataBits)} data bits, parity ${parity}, ${String(stopBits)} stop bits`;
    }
    case 'control-lines':
      return `DTR ${event.isDtrSet ? 'on' : 'off'}, RTS ${event.isRtsSet ? 'on' : 'off'}`;
    case 'break':
      return 'break';
    case 'from-host':
      return `host -> device  ${describeBytes(event.bytes)}`;
    case 'writes-held':
      return `write held, ${String(event.count)} in flight (device is hung)`;
    case 'to-host':
      return `device -> host  ${describeBytes(event.bytes)}`;
  }
}

function describeServerEvent(event: ServerEvent): string {
  switch (event.kind) {
    case 'listening':
      return `USB/IP server listening on ${event.host}:${String(event.port)}`;
    case 'device-listed':
      return `device list requested by ${event.remoteAddress}`;
    case 'attached':
      return `attached by ${event.remoteAddress}`;
    case 'import-refused':
      return `import by ${event.remoteAddress} refused: ${event.reason}`;
    case 'detached':
      return `detached (${event.reason})`;
    case 'protocol-error':
      return `protocol error from ${event.remoteAddress}: ${event.message}`;
  }
}

function describeStatus(status: DeviceStatus): string {
  const { lineCoding } = status;
  return [
    `plugged in: ${yesNo(server.isPluggedIn)}, attached: ${yesNo(server.isAttached)}, configuration: ${String(status.configurationValue)}`,
    `behaviour: ${status.behaviour}, hung: ${yesNo(status.isHung)} (${String(status.heldWrites)} held), chunk cap: ${status.maxChunkBytes === undefined ? 'off' : String(status.maxChunkBytes)}`,
    `line coding: ${String(lineCoding.baudRate)} ${String(lineCoding.dataBits)}/${lineCoding.parity}/${String(lineCoding.stopBits)}, DTR ${yesNo(status.isDtrSet)}, RTS ${yesNo(status.isRtsSet)}`,
    `bytes from host: ${String(status.bytesFromHost)}, to host: ${String(status.bytesToHost)}, queued: ${String(status.bytesQueuedToHost)}`,
  ].join('\n         ');
}

function parseId(text: string, flag: string): number {
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    process.stderr.write(`${flag} must be an integer from 0 to 0xffff, got "${text}".\n`);
    process.exit(2);
  }
  return value;
}

function log(line: string): void {
  const time = new Date().toTimeString().slice(0, 8);
  process.stdout.write(`${time}  ${line}\n`);
}

function hex4(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}
