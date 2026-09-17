import {
  DEFAULT_CONNECTION_SETTINGS,
  DEFAULT_ENCODING_SETTINGS,
  DEFAULT_MAX_TABS,
  DEFAULT_RECEIVE_SETTINGS,
  DEFAULT_SERIAL_SETTINGS,
  DEFAULT_REMEMBER,
} from '../../src/core/defaults.js';
import type { EffectiveSettings } from '../../src/core/diagnostics.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import type { ConnectionSettings } from '../../src/core/types.js';

import { formatUsbId } from './format.js';

/**
 * The setup form: every option `setup()` accepts, as the strings and flags the inputs hold.
 *
 * The page deliberately does not validate. It hands what was typed to the library and shows the
 * library's verdict, because the point of a debugging surface is to show what the library does -
 * and a second, subtly different opinion in the page would hide exactly that.
 */

/** A connection setting typed into a text field; `autoReconnect` is a checkbox of its own. */
type ConnectionField = Exclude<keyof ConnectionSettings, 'autoReconnect'>;

/** Every connection setting typed into a text field, in the order the library documents them. */
const CONNECTION_FIELDS = (
  Object.keys(DEFAULT_CONNECTION_SETTINGS) as (keyof ConnectionSettings)[]
).filter((field): field is ConnectionField => field !== 'autoReconnect');

/** How the form names the device: the device list's non-preset entries (ADR-0036). */
export type DeviceKindChoice = 'auto' | 'usb' | 'non-usb' | 'any';

/** Every field of the form. An empty string means "leave it to the library's default". */
export interface SetupFormValues {
  readonly name: string;
  readonly deviceKind: DeviceKindChoice;
  /**
   * What an auto-mode configuration has resolved to, kept so that editing its line settings does
   * not ask for the device again: `'usb'` with the IDs in `vendorId` and `productId`, `'non-usb'`,
   * or blank for one that has not resolved. Meaningless unless `deviceKind` is `'auto'`.
   */
  readonly resolved: '' | 'usb' | 'non-usb';
  readonly vendorId: string;
  readonly productId: string;
  readonly baudRate: string;
  readonly dataBits: string;
  readonly stopBits: string;
  readonly parity: string;
  readonly bufferSize: string;
  readonly flowControl: string;
  readonly connection: Readonly<Record<ConnectionField, string>>;
  readonly autoReconnect: boolean;
  /** `receive.idleMs` and `receive.maxWaitMs`, as typed. */
  readonly receiveIdleMs: string;
  readonly receiveMaxWaitMs: string;
  readonly encoding: string;
  readonly decodeText: boolean;
  readonly remember: boolean;
  /** How many tabs may use the configuration at once: a number, `Infinity`, or blank. */
  readonly maxTabs: string;
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

/** What a configuration is called before anyone knows what its device is. */
export const DEFAULT_NAME = 'Device';

/**
 * What the form holds when the dialog opens: auto mode, so the device comes from the port the
 * user chooses, with the first preset's IDs ready should they switch to naming one.
 */
export function defaultFormValues(): SetupFormValues {
  const [firstPreset] = DEVICE_PRESETS;
  return {
    name: DEFAULT_NAME,
    deviceKind: 'auto',
    resolved: '',
    vendorId: firstPreset?.vendorId ?? '',
    productId: firstPreset?.productId ?? '',
    baudRate: '9600',
    dataBits: '',
    stopBits: '',
    parity: '',
    bufferSize: '',
    flowControl: '',
    connection: blankConnection(),
    autoReconnect: DEFAULT_CONNECTION_SETTINGS.autoReconnect,
    receiveIdleMs: '',
    receiveMaxWaitMs: '',
    encoding: '',
    // A checkbox cannot be left blank, so it starts at the library's default instead.
    decodeText: DEFAULT_ENCODING_SETTINGS.decodeText,
    remember: DEFAULT_REMEMBER,
    maxTabs: '',
  };
}

/**
 * The library's default for each field that may be left blank, as the text an input shows as
 * its placeholder.
 *
 * Read from the library's own defaults, so the dialog cannot promise a default the library no
 * longer applies.
 */
export function defaultPlaceholders(): Readonly<Record<string, string>> {
  const placeholders: Record<string, string> = {};
  for (const [field, value] of Object.entries(DEFAULT_SERIAL_SETTINGS)) {
    placeholders[field] = String(value);
  }
  for (const field of CONNECTION_FIELDS) {
    placeholders[`connection.${field}`] = String(DEFAULT_CONNECTION_SETTINGS[field]);
  }
  placeholders['receive.idleMs'] = String(DEFAULT_RECEIVE_SETTINGS.idleMs);
  placeholders['receive.maxWaitMs'] = String(DEFAULT_RECEIVE_SETTINGS.maxWaitMs);
  placeholders['encoding'] = DEFAULT_ENCODING_SETTINGS.encoding;
  placeholders['maxTabs'] = String(DEFAULT_MAX_TABS);
  return placeholders;
}

/**
 * Works out which entry of the device list describes the values: `'auto'`, a preset's index,
 * `'custom'`, `'non-usb'` or `'any'`.
 */
export function deviceChoiceFor(values: SetupFormValues): string {
  if (values.deviceKind !== 'usb') {
    return values.deviceKind;
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
  return {
    name,
    ...deviceValuesFor(device),
    baudRate: String(serial.baudRate),
    dataBits: String(serial.dataBits),
    stopBits: String(serial.stopBits),
    parity: serial.parity,
    bufferSize: String(serial.bufferSize),
    flowControl: serial.flowControl,
    connection: connectionText,
    autoReconnect: connection.autoReconnect,
    receiveIdleMs: String(settings.receive.idleMs),
    receiveMaxWaitMs: String(settings.receive.maxWaitMs),
    encoding: encoding.encoding,
    decodeText: encoding.decodeText,
    remember: settings.remember,
    maxTabs: String(settings.maxTabs),
  };
}

/** The device fields of the form for a device filter as a configuration reports it. */
function deviceValuesFor(
  device: EffectiveSettings['device'],
): Pick<SetupFormValues, 'deviceKind' | 'resolved' | 'vendorId' | 'productId'> {
  if ('any' in device) {
    return { deviceKind: 'any', resolved: '', vendorId: '', productId: '' };
  }
  if ('nonUsb' in device) {
    return { deviceKind: 'non-usb', resolved: '', vendorId: '', productId: '' };
  }
  if ('auto' in device) {
    const resolved = device.resolved;
    if (resolved === undefined) {
      return { deviceKind: 'auto', resolved: '', vendorId: '', productId: '' };
    }
    return 'nonUsb' in resolved
      ? { deviceKind: 'auto', resolved: 'non-usb', vendorId: '', productId: '' }
      : {
          deviceKind: 'auto',
          resolved: 'usb',
          vendorId: formatUsbId(resolved.vendorId),
          productId: formatUsbId(resolved.productId),
        };
  }
  return {
    deviceKind: 'usb',
    resolved: '',
    vendorId: formatUsbId(device.vendorId),
    productId: formatUsbId(device.productId),
  };
}

/** The `device` option the form describes; see {@link buildSetupOptions}. */
function deviceOptionFor(values: SetupFormValues): Record<string, unknown> {
  switch (values.deviceKind) {
    case 'any':
      return { any: true };
    case 'non-usb':
      return { nonUsb: true };
    case 'auto':
      // The resolution travels with the configuration, so editing a baud rate does not ask for
      // the device again (ADR-0036).
      switch (values.resolved) {
        case 'usb':
          return {
            auto: true,
            resolved: {
              vendorId: toNumber(values.vendorId),
              productId: toNumber(values.productId),
            },
          };
        case 'non-usb':
          return { auto: true, resolved: { nonUsb: true } };
        default:
          return { auto: true };
      }
    default:
      return { vendorId: toNumber(values.vendorId), productId: toNumber(values.productId) };
  }
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
  const connection: Record<string, number | boolean> = { autoReconnect: values.autoReconnect };
  for (const field of CONNECTION_FIELDS) {
    const text = values.connection[field].trim();
    if (text !== '') {
      connection[field] = toNumber(text);
    }
  }

  return {
    device: deviceOptionFor(values),
    serial: {
      baudRate: toNumber(values.baudRate),
      ...optionalNumber('dataBits', values.dataBits),
      ...optionalNumber('stopBits', values.stopBits),
      ...optionalText('parity', values.parity),
      ...optionalNumber('bufferSize', values.bufferSize),
      ...optionalText('flowControl', values.flowControl),
    },
    connection,
    receive: {
      ...optionalNumber('idleMs', values.receiveIdleMs),
      ...optionalNumber('maxWaitMs', values.receiveMaxWaitMs),
    },
    encoding: { ...optionalText('encoding', values.encoding), decodeText: values.decodeText },
    remember: values.remember,
    ...optionalNumber('maxTabs', values.maxTabs),
  };
}

/**
 * The form field a rejection from the library names: `baudRate`, `connection.jitter`, `vendorId`.
 *
 * The library names the rejected option in `context.argumentName`, as `options.serial.baudRate`.
 * The dialog uses the field to show it, which matters for the options folded away under "More
 * options": a message naming a field nobody can see is a dead end.
 *
 * @returns The field's name in the form, or `undefined` when the rejection names none.
 */
export function rejectedField(error: unknown): string | undefined {
  if (!(error instanceof SerialBrokerError)) {
    return undefined;
  }
  const argumentName = error.context.argumentName;
  if (typeof argumentName !== 'string') {
    return undefined;
  }
  const [root, group, field] = argumentName.split('.');
  if (root === 'name') {
    return 'name';
  }
  if (root !== 'options') {
    return undefined;
  }
  switch (group) {
    case 'device':
      return field === 'vendorId' || field === 'productId' ? field : 'device';
    case 'serial':
    case 'encoding':
      return field;
    case 'connection':
    case 'receive':
      return field === undefined ? undefined : `${group}.${field}`;
    case 'remember':
    case 'maxTabs':
      return group;
    default:
      return undefined;
  }
}

/** Reads every field from the form element. */
export function readSetupForm(form: HTMLFormElement): SetupFormValues {
  const connection = blankConnection();
  for (const field of CONNECTION_FIELDS) {
    connection[field] = textField(form, `connection.${field}`);
  }
  const resolved = textField(form, 'resolved');
  return {
    name: textField(form, 'name').trim(),
    deviceKind: deviceKindOf(textField(form, 'device')),
    resolved: resolved === 'usb' || resolved === 'non-usb' ? resolved : '',
    vendorId: textField(form, 'vendorId'),
    productId: textField(form, 'productId'),
    baudRate: textField(form, 'baudRate'),
    dataBits: textField(form, 'dataBits'),
    stopBits: textField(form, 'stopBits'),
    parity: textField(form, 'parity'),
    bufferSize: textField(form, 'bufferSize'),
    flowControl: textField(form, 'flowControl'),
    connection,
    autoReconnect: checkbox(form, 'connection.autoReconnect').checked,
    receiveIdleMs: textField(form, 'receive.idleMs'),
    receiveMaxWaitMs: textField(form, 'receive.maxWaitMs'),
    encoding: textField(form, 'encoding'),
    decodeText: checkbox(form, 'decodeText').checked,
    remember: checkbox(form, 'remember').checked,
    maxTabs: textField(form, 'maxTabs'),
  };
}

/** Writes every field except the device list, which the dialog derives, into the form. */
export function writeSetupForm(form: HTMLFormElement, values: SetupFormValues): void {
  const set = (name: string, value: string): void => {
    input(form, name).value = value;
  };
  set('name', values.name);
  set('resolved', values.resolved);
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
  checkbox(form, 'connection.autoReconnect').checked = values.autoReconnect;
  set('receive.idleMs', values.receiveIdleMs);
  set('receive.maxWaitMs', values.receiveMaxWaitMs);
  set('encoding', values.encoding);
  checkbox(form, 'decodeText').checked = values.decodeText;
  checkbox(form, 'remember').checked = values.remember;
  set('maxTabs', values.maxTabs);
}

/** The device kind a device list entry stands for: every entry not named here is a USB one. */
function deviceKindOf(choice: string): DeviceKindChoice {
  return choice === 'auto' || choice === 'any' || choice === 'non-usb' ? choice : 'usb';
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
