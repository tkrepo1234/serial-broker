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

/** A USB device the form can be filled with. */
export interface DevicePreset {
  readonly label: string;
  readonly vendorId: string;
  readonly productId: string;
}

/** Common USB-serial chips, and the emulated device from `emulator/`. */
export const DEVICE_PRESETS: readonly DevicePreset[] = [
  { label: 'CH340 adapter', vendorId: '0x1a86', productId: '0x7523' },
  { label: 'FTDI FT232R', vendorId: '0x0403', productId: '0x6001' },
  { label: 'Silicon Labs CP210x', vendorId: '0x10c4', productId: '0xea60' },
  { label: 'Emulated device (emulator/)', vendorId: '0x1209', productId: '0x0001' },
];

/** What the form holds when the dialog opens. */
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
 * Works out which entry of the device list describes the values: a preset's index, `'custom'`,
 * or `'any'`.
 */
export function deviceChoiceFor(values: SetupFormValues): string {
  if (values.deviceKind === 'any') {
    return 'any';
  }
  const index = DEVICE_PRESETS.findIndex(
    (preset) =>
      preset.vendorId === values.vendorId.trim().toLowerCase() &&
      preset.productId === values.productId.trim().toLowerCase(),
  );
  return index === -1 ? 'custom' : String(index);
}

/**
 * The form values that describe the settings a configuration runs with, for editing them.
 *
 * Every field is filled, defaults included, so what the dialog shows is exactly what runs.
 */
export function formValuesFor(name: string, settings: EffectiveSettings): SetupFormValues {
  const { device, serial, connection, encoding } = settings;
  const connectionText = blankConnection();
  for (const field of CONNECTION_FIELDS) {
    connectionText[field] = String(connection[field]);
  }
  const hex = (value: number): string => `0x${value.toString(16).padStart(4, '0')}`;
  return {
    name,
    deviceKind: 'any' in device ? 'any' : 'usb',
    vendorId: 'any' in device ? '' : hex(device.vendorId),
    productId: 'any' in device ? '' : hex(device.productId),
    baudRate: String(serial.baudRate),
    dataBits: String(serial.dataBits),
    stopBits: String(serial.stopBits),
    parity: serial.parity,
    bufferSize: String(serial.bufferSize),
    flowControl: serial.flowControl,
    connection: connectionText,
    encoding: encoding.encoding,
    decodeText: encoding.decodeText,
    persist: settings.persist,
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

/** Reads every field from the form element. */
export function readSetupForm(form: HTMLFormElement): SetupFormValues {
  const connection = blankConnection();
  for (const field of CONNECTION_FIELDS) {
    connection[field] = textField(form, `connection.${field}`);
  }
  return {
    name: textField(form, 'name').trim(),
    deviceKind: textField(form, 'device') === 'any' ? 'any' : 'usb',
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

/** Writes every field except the device list, which the dialog derives, into the form. */
export function writeSetupForm(form: HTMLFormElement, values: SetupFormValues): void {
  const set = (name: string, value: string): void => {
    input(form, name).value = value;
  };
  set('name', values.name);
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

function input(form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement {
  const item = form.elements.namedItem(name);
  if (item instanceof HTMLInputElement || item instanceof HTMLSelectElement) {
    return item;
  }
  throw new Error(`The setup form has no field named "${name}"`);
}

function textField(form: HTMLFormElement, name: string): string {
  return input(form, name).value;
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
