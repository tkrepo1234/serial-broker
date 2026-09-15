import { isSupported, SerialBroker, type Logger } from 'serial-broker';

const consoleLogger: Logger = {
  log(level, message, fields) {
    console[level](`[serial-broker] ${message}`, fields);
  },
};

/**
 * Library-wide settings. They are read once, by the first call that needs serial-broker's client -
 * `setup()` or `restore()`, typically - so this runs before any of them.
 */
export function configureSerialBroker(): void {
  SerialBroker.configure({
    // Only needed when the bundler does not emit the worker script on its own.
    workerUrl: new URL('/assets/serial-broker.worker.js', location.origin),
    transport: 'auto',
    logger: consoleLogger,
    // Serial traffic can carry card numbers and PINs; keep bytes out of the log.
    logPayloads: false,
  });
}

/** A port with no USB identity: a built-in RS-232 interface on an industrial PC. */
export async function setUpPanelPort(): Promise<boolean> {
  if (!isSupported()) {
    return false;
  }
  await SerialBroker.setup('PanelPort', {
    device: { any: true },
    serial: {
      baudRate: 115_200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'hardware',
    },
    connection: { maxDelayMs: 5_000, writeTimeoutMs: 2_000 },
    remember: false,
  });
  return true;
}
