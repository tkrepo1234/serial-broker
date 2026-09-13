import { DEFAULT_CONNECTION_SETTINGS } from '../../src/core/defaults.js';
import type { EffectiveSettings } from '../../src/core/diagnostics.js';
import type { ConnectionSettings } from '../../src/core/types.js';

/**
 * The setup form: every option `setup()` accepts, as the strings and flags the inputs hold.
 *
 * The page deliberately does not validate. It hands what was typed to the library and shows the
 * library's verdict, because the point of a debugging surface is to show what the library does -
 * and a second, subtly different opinion in the page would hide exactly that.
 */

/** A connection setting's name. */
export type ConnectionField = keyof ConnectionSettings;

/** Every connection setting, in the order the library documents them. */
export const CONNECTION_FIELDS = Object.keys(DEFAULT_CONNECTION_SETTINGS) as ConnectionField[];

/** Every field of the form. An empty string means "leave it to the library's default". */
export interface SetupFormValues {
  readonly name: string;
  readonly deviceKind: 'usb' | 'any';
  readonly vendorId: string;
  readonly productId: string;
  readonly baudRate: string;
  readonly dataBits: string;
  readonly stopBits: string;
  readonly parity: string;
  readonly bufferSize: string;
  readonly flowControl: string;
  readonly connection: Readonly<Record<ConnectionField, string>>;
  readonly encoding: string;
  readonly decodeText: boolean;
  readonly persist: boolean;
}

/** A device the form can be pre-filled with. */
export interface DevicePreset {
  readonly label: string;
  readonly vendorId: number | undefined;
  readonly productId: number | undefined;
}

/** Common USB-serial chips, the emulated device, and a port with no USB identity. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { label: 'CH340 USB-serial adapter (0x1a86:0x7523)', vendorId: 0x1a86, productId: 0x7523 },
  { label: 'FTDI FT232R (0x0403:0x6001)', vendorId: 0x0403, productId: 0x6001 },
  { label: 'Silicon Labs CP210x (0x10c4:0xea60)', vendorId: 0x10c4, productId: 0xea60 },
  { label: 'Emulated device from emulator/ (0x1209:0x0001)', vendorId: 0x1209, productId: 0x0001 },
  { label: 'Any granted port, no USB identity', vendorId: undefined, productId: undefined },
];

/** What the form holds when the page opens. */
export function defaultFormValues(): SetupFormValues {
  return {
    name: 'Device',
    deviceKind: 'usb',
    vendorId: '0x1a86',
    productId: '0x7523',
    baudRate: '9600',
    dataBits: '',
    stopBits: '',
    parity: '',
    bufferSize: '',
    flowControl: '',
    connection: blankConnection(),
    encoding: '',
    decodeText: true,
    persist: true,
  };
}

/**
 * Turns the form into the options object `setup()` receives.
 *
 * Blank optional fields are left out, so the library's defaults apply. Anything typed into a
 * numeric field is converted with `Number`, which accepts `0x1a86` and `Infinity`; anything that
 * is not a number becomes `NaN`, and the library names the field when it rejects it.
 *
 * @returns Options that have **not** been validated. Pass them to `setup()` and show what it says.
 */
export function buildSetupOptions(values: SetupFormValues): Record<string, unknown> {
  const connection: Record<string, number> = {};
  for (const field of CONNECTION_FIELDS) {
    const text = values.connection[field].trim();
    if (text !== '') {
      connection[field] = toNumber(text);
    }
  }

  return {
    device:
      values.deviceKind === 'any'
        ? { any: true }
        : { vendorId: toNumber(values.vendorId), productId: toNumber(values.productId) },
    serial: {
      baudRate: toNumber(values.baudRate),
      ...optionalNumber('dataBits', values.dataBits),
      ...optionalNumber('stopBits', values.stopBits),
      ...optionalText('parity', values.parity),
      ...optionalNumber('bufferSize', values.bufferSize),
      ...optionalText('flowControl', values.flowControl),
    },
    connection,
    encoding: { ...optionalText('encoding', values.encoding), decodeText: values.decodeText },
    persist: values.persist,
  };
}

/**
 * Fills the form from settings a configuration is running with - its own, or another tab's
 * from a diagnostics report - so what is running can be reproduced exactly.
 */
export function valuesFromSettings(name: string, settings: EffectiveSettings): SetupFormValues {
  const { device, serial, encoding } = settings;
  const connection = blankConnection();
  for (const field of CONNECTION_FIELDS) {
    connection[field] = String(settings.connection[field]);
  }
  return {
    name,
    deviceKind: 'any' in device ? 'any' : 'usb',
    vendorId: 'vendorId' in device ? toHexId(device.vendorId) : '',
    productId: 'productId' in device ? toHexId(device.productId) : '',
    baudRate: String(serial.baudRate),
    dataBits: String(serial.dataBits),
    stopBits: String(serial.stopBits),
    parity: serial.parity,
    bufferSize: String(serial.bufferSize),
    flowControl: serial.flowControl,
    connection,
    encoding: encoding.encoding,
    decodeText: encoding.decodeText,
    persist: settings.persist,
  };
}

/** Reads every field from the form element. */
export function readSetupForm(form: HTMLFormElement): SetupFormValues {
  const connection = blankConnection();
  for (const field of CONNECTION_FIELDS) {
    connection[field] = textField(form, `connection.${field}`);
  }
  return {
    name: textField(form, 'name').trim(),
    deviceKind: textField(form, 'deviceKind') === 'any' ? 'any' : 'usb',
    vendorId: textField(form, 'vendorId'),
    productId: textField(form, 'productId'),
    baudRate: textField(form, 'baudRate'),
    dataBits: textField(form, 'dataBits'),
    stopBits: textField(form, 'stopBits'),
    parity: textField(form, 'parity'),
    bufferSize: textField(form, 'bufferSize'),
    flowControl: textField(form, 'flowControl'),
    connection,
    encoding: textField(form, 'encoding'),
    decodeText: checkbox(form, 'decodeText').checked,
    persist: checkbox(form, 'persist').checked,
  };
}

/** Writes every field into the form element. */
export function writeSetupForm(form: HTMLFormElement, values: SetupFormValues): void {
  const set = (name: string, value: string): void => {
    const item = form.elements.namedItem(name);
    if (item instanceof RadioNodeList) {
      item.value = value;
    } else if (item instanceof HTMLInputElement || item instanceof HTMLSelectElement) {
      item.value = value;
    } else {
      throw new Error(`The setup form has no field named "${name}"`);
    }
  };
  set('name', values.name);
  set('deviceKind', values.deviceKind);
  set('vendorId', values.vendorId);
  set('productId', values.productId);
  set('baudRate', values.baudRate);
  set('dataBits', values.dataBits);
  set('stopBits', values.stopBits);
  set('parity', values.parity);
  set('bufferSize', values.bufferSize);
  set('flowControl', values.flowControl);
  for (const field of CONNECTION_FIELDS) {
    set(`connection.${field}`, values.connection[field]);
  }
  set('encoding', values.encoding);
  checkbox(form, 'decodeText').checked = values.decodeText;
  checkbox(form, 'persist').checked = values.persist;
}

function textField(form: HTMLFormElement, name: string): string {
  const item = form.elements.namedItem(name);
  if (item instanceof RadioNodeList) {
    return item.value;
  }
  if (item instanceof HTMLInputElement || item instanceof HTMLSelectElement) {
    return item.value;
  }
  throw new Error(`The setup form has no field named "${name}"`);
}

function checkbox(form: HTMLFormElement, name: string): HTMLInputElement {
  const item = form.elements.namedItem(name);
  if (!(item instanceof HTMLInputElement)) {
    throw new Error(`The setup form has no checkbox named "${name}"`);
  }
  return item;
}

function blankConnection(): Record<ConnectionField, string> {
  const connection = {} as Record<ConnectionField, string>;
  for (const field of CONNECTION_FIELDS) {
    connection[field] = '';
  }
  return connection;
}

function toNumber(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? Number.NaN : Number(trimmed);
}

function optionalNumber(key: string, text: string): Record<string, number> {
  return text.trim() === '' ? {} : { [key]: toNumber(text) };
}

function optionalText(key: string, text: string): Record<string, string> {
  return text.trim() === '' ? {} : { [key]: text.trim() };
}

function toHexId(value: number): string {
  return `0x${value.toString(16).padStart(4, '0')}`;
}
