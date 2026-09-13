/**
 * Formatting for the debugging surface.
 *
 * Pure functions with no DOM access, so the rules for what an operator sees are unit-tested
 * rather than eyeballed.
 */

import { SerialBrokerError } from '../../src/core/errors.js';
import type { EffectiveSettings } from '../../src/diagnostics.js';

/** Control characters that still count as printable text in serial traffic. */
const PRINTABLE_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

const REPLACEMENT_CHARACTER = '�';

/**
 * Renders a payload as quoted text when it is readable, and as hex bytes when it is not.
 *
 * @param data - The bytes.
 * @param text - Text the library already decoded, if any. Used as-is when given.
 * @returns A single line.
 */
export function describePayload(data: Uint8Array, text?: string): string {
  const decoded = text ?? new TextDecoder().decode(data);
  if (isPrintable(decoded) && !decoded.includes(REPLACEMENT_CHARACTER)) {
    return JSON.stringify(decoded);
  }
  return toHex(data);
}

/** Renders bytes as upper-case hex pairs separated by spaces. */
export function toHex(data: Uint8Array): string {
  return [...data].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/**
 * Parses hex bytes as an operator types them: `02 FF 03`, `02ff03`, `0x02,0xff`.
 *
 * Every group between spaces, commas or colons has to hold whole bytes: `0x1 0x2` is a typing
 * mistake, not the byte `0x12`.
 *
 * @throws An `Error` naming the input when it is not a sequence of whole hex bytes.
 */
export function parseHexBytes(input: string): Uint8Array<ArrayBuffer> {
  const groups: string[] = [];
  for (const group of input.split(/[\s,:]+/)) {
    if (group === '') {
      continue;
    }
    const digits = group.replace(/^0x/i, '');
    if (digits.length === 0 || digits.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(digits)) {
      throw new Error(`"${input}" is not a sequence of hex bytes, such as 02 FF 03.`);
    }
    groups.push(digits);
  }
  const compact = groups.join('');
  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Renders epoch milliseconds as a local wall-clock time with milliseconds. */
export function formatClock(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/**
 * Renders how far a moment is from now: `in 1.4 s`, `320 ms ago`, `2 min 5 s ago`.
 *
 * @param targetMs - The moment, in epoch milliseconds.
 * @param nowMs - Now, in epoch milliseconds.
 */
export function formatRelative(targetMs: number, nowMs: number): string {
  const delta = targetMs - nowMs;
  const magnitude = Math.abs(delta);
  let text: string;
  if (magnitude < 1_000) {
    text = `${String(Math.round(magnitude))} ms`;
  } else if (magnitude < 60_000) {
    text = `${(magnitude / 1_000).toFixed(1)} s`;
  } else {
    const minutes = Math.floor(magnitude / 60_000);
    const seconds = Math.round((magnitude % 60_000) / 1_000);
    text = `${String(minutes)} min ${String(seconds)} s`;
  }
  return delta > 0 ? `in ${text}` : `${text} ago`;
}

/**
 * A status in the words an operator reads at a glance.
 *
 * "Port open" rather than "Connected", so the device's state is not confused with this page being
 * connected to the configuration.
 *
 * @param status - A status as the library reports it, or `undefined` when no tab runs it.
 */
export function statusLabel(status: string | undefined): string {
  switch (status) {
    case undefined:
      return 'Not running';
    case 'idle':
      return 'Idle';
    case 'awaiting-permission':
      return 'Waiting for device';
    case 'connecting':
      return 'Opening port';
    case 'open':
      return 'Port open';
    case 'reconnecting':
      return 'Reconnecting';
    case 'failed':
      return 'Failed';
    case 'released':
      return 'Released';
    default:
      // A status a later version of the library adds is shown as it is, not hidden.
      return status;
  }
}

/** A configuration's device as `0x1a86:7523`, or `any port`. */
export function summarizeDevice(settings: EffectiveSettings): string {
  const { device } = settings;
  return 'any' in device ? 'any port' : formatDevice(device.vendorId, device.productId);
}

/**
 * A USB device as `0x1a86:7523`: the vendor ID in full, the product ID without a second `0x`.
 *
 * One rendering for the list, the settings and the port facts, so the same device never looks
 * like two.
 */
export function formatDevice(vendorId: number | undefined, productId: number | undefined): string {
  return `${formatUsbId(vendorId)}:${formatUsbId(productId).replace(/^0x/, '')}`;
}

/**
 * Why something failed, in one line: the error code and what to do about it for a serial-broker
 * error, the message for anything else.
 *
 * @returns The line, and for a serial-broker error its message as a longer explanation.
 */
export function describeError(error: unknown): { readonly text: string; readonly detail: string } {
  if (error instanceof SerialBrokerError) {
    return { text: `${error.code}: ${error.remediation}`, detail: error.message };
  }
  return { text: error instanceof Error ? error.message : String(error), detail: '' };
}

/** A configuration's device and line settings on one line: `0x1a86:7523 · 9600 8N1`. */
export function summarizeSettings(settings: EffectiveSettings): string {
  const { serial } = settings;
  const parity = PARITY_LETTERS[serial.parity] ?? '?';
  return `${summarizeDevice(settings)} · ${String(serial.baudRate)} ${String(serial.dataBits)}${parity}${String(serial.stopBits)}`;
}

const PARITY_LETTERS: Readonly<Record<string, string>> = { none: 'N', even: 'E', odd: 'O' };

/** Renders a USB vendor or product ID as `0x1a86`, or a dash when there is none. */
export function formatUsbId(value: number | undefined): string {
  return value === undefined ? '—' : `0x${value.toString(16).padStart(4, '0')}`;
}

/** Renders one setting or status value for a table cell. */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '—';
  }
  if (value === Number.POSITIVE_INFINITY) {
    return '∞';
  }
  if (typeof value === 'boolean') {
    return value ? 'yes' : 'no';
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return String(value);
  }
  return formatDetail(value);
}

/** Shortens an opaque context identifier to something a table column can hold. */
export function shortClientId(clientId: string): string {
  return clientId.length <= 14 ? clientId : `${clientId.slice(0, 7)}…${clientId.slice(-5)}`;
}

/**
 * Renders any value as indented JSON for an expandable detail view.
 *
 * Bytes become hex and non-finite numbers stay readable, which plain `JSON.stringify` would turn
 * into an index-keyed object and `null` respectively.
 */
export function formatDetail(value: unknown): string {
  const json = JSON.stringify(
    value,
    (_key, entry: unknown) => {
      if (entry instanceof Uint8Array) {
        return toHex(entry);
      }
      if (typeof entry === 'number' && !Number.isFinite(entry)) {
        return String(entry);
      }
      if (typeof entry === 'bigint') {
        return entry.toString();
      }
      return entry;
    },
    2,
  ) as string | undefined;
  return json ?? String(value);
}

/** Renders a byte count: `512 B`, `4.1 KB`. */
export function formatBytes(count: number): string {
  return count < 1_024 ? `${String(count)} B` : `${(count / 1_024).toFixed(1)} KB`;
}

function isPrintable(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && !PRINTABLE_CONTROLS.has(code)) || code === 0x7f) {
      return false;
    }
  }
  return true;
}
