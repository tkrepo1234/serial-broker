/**
 * Formatting for the debugging surface.
 *
 * Pure functions with no DOM access, so the rules for what an operator sees are unit-tested
 * rather than eyeballed.
 */

import { SerialBrokerError } from '../../src/core/errors.js';
import type { DiagnosticsSnapshot, EffectiveSettings } from '../../src/diagnostics.js';

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
  // Rounded to what each unit shows before the unit is chosen, so a value just below a boundary
  // reads "1.0 s" or "1 min 0 s" rather than "1000 ms" or "1 min 60 s".
  const milliseconds = Math.round(magnitude);
  const tenths = Math.round(magnitude / 100);
  const seconds = Math.round(magnitude / 1_000);
  let text: string;
  if (milliseconds < 1_000) {
    text = `${String(milliseconds)} ms`;
  } else if (tenths < 600) {
    text = `${(tenths / 10).toFixed(1)} s`;
  } else {
    text = `${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s`;
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
    case 'queued':
      return 'Queued for a place';
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

/**
 * A configuration's device as `0x1a86:7523`, `any port`, `port without USB identity`, or - for
 * one in auto mode that has not resolved - `not chosen yet`.
 *
 * A resolved auto-mode configuration reads as the device it resolved to: that is what it opens,
 * and what a `setup()` written from these facts may name outright.
 */
export function summarizeDevice(settings: EffectiveSettings): string {
  const { device } = settings;
  if ('any' in device) {
    return 'any port';
  }
  if ('nonUsb' in device) {
    return 'port without USB identity';
  }
  if ('auto' in device) {
    const resolved = device.resolved;
    if (resolved === undefined) {
      return 'not chosen yet';
    }
    return 'nonUsb' in resolved
      ? 'port without USB identity'
      : formatDevice(resolved.vendorId, resolved.productId);
  }
  return formatDevice(device.vendorId, device.productId);
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

/** Renders a byte count: `512 B`, `4.1 KB`, `2.3 MB`. */
export function formatBytes(count: number): string {
  if (count < 1_024) {
    return `${String(count)} B`;
  }
  // Rounded before the unit is chosen, as in formatRelative, so a count just below a megabyte
  // reads "1.0 MB" rather than "1024.0 KB".
  const kilobyteTenths = Math.round((count * 10) / 1_024);
  if (kilobyteTenths < 10_240) {
    return `${(kilobyteTenths / 10).toFixed(1)} KB`;
  }
  return `${(Math.round((count * 10) / 1_048_576) / 10).toFixed(1)} MB`;
}

/** A count with its noun: `1 tab`, `3 tabs`. */
export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * How the page names a tab: `This page` for itself, `Tab c-12-3f…-bbbb` for any other.
 *
 * One naming for the tabs table, the traffic and the hints, so this page never appears as "this
 * tab" in one place and "This page" in another.
 */
export function tabLabel(clientId: string, thisTabId: string | undefined): string {
  return clientId === thisTabId ? 'This page' : `Tab ${shortClientId(clientId)}`;
}

/**
 * Which tab holds each port and how many wait for it, from the origin's Web Locks:
 * `Scale: held, 2 waiting · Panel: free`.
 *
 * Only ownership locks count. A tab limit adds a lock per place and a gate, which would each read
 * as the configuration's name here. A lock of another protocol version is marked with it: tabs on
 * that version take the port under a lock of their own, so the same name can appear twice.
 *
 * @param locks - The snapshot's locks, or `undefined` where the browser cannot list them.
 * @param protocolVersion - This page's protocol version.
 */
export function describeOwnershipLocks(
  locks: DiagnosticsSnapshot['locks'],
  protocolVersion: number,
): string {
  if (locks === undefined) {
    return 'not listed by this browser';
  }
  // The format `ownerLockName()` in src/protocol/version.ts produces. Everything after the
  // version is the configuration name, which may itself contain slashes.
  const ownership = /^serial-broker\/owner\/v(\d+)\/(.+)$/s;
  const entries = new Map<string, { label: string; isHeld: boolean; waiting: number }>();
  const count = (lock: { readonly name: string }, isHeld: boolean): void => {
    const match = ownership.exec(lock.name);
    if (match === null) {
      return;
    }
    const [, version = '', configName = ''] = match;
    let entry = entries.get(lock.name);
    if (entry === undefined) {
      const label =
        Number(version) === protocolVersion ? configName : `${configName} (protocol ${version})`;
      entry = { label, isHeld: false, waiting: 0 };
      entries.set(lock.name, entry);
    }
    if (isHeld) {
      entry.isHeld = true;
    } else {
      entry.waiting += 1;
    }
  };
  for (const lock of locks.held) {
    count(lock, true);
  }
  for (const lock of locks.pending) {
    count(lock, false);
  }
  if (entries.size === 0) {
    return 'none';
  }
  return [...entries.values()]
    .map(
      ({ label, isHeld, waiting }) =>
        `${label}: ${isHeld ? 'held' : 'free'}${waiting > 0 ? `, ${String(waiting)} waiting` : ''}`,
    )
    .join(' · ');
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
