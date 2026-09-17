import { SerialBrokerStatus } from '../core/types.js';

/**
 * The type guards the message-boundary validators are built from (ADR-0008).
 *
 * Both `decode.ts` and `decode-diagnostics.ts` ask the same questions of untrusted values - is
 * this an object, a name, a number, a status - and two private copies of the answers drift
 * apart. One set means a field is judged the same way wherever it appears.
 * See docs/guidelines/defensive-programming.md.
 */

/**
 * `true` for a plain object whose fields can be read by name.
 *
 * Arrays are rejected. No message, report or nested shape of the protocol is an array where a
 * record is expected, and an array passing this check would only fail later, on a field it
 * cannot have, with a less accurate reason.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `true` for a string with at least one character, as every name and identifier must be. */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** `true` for a number that is neither `NaN` nor infinite, as timestamps and versions are. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `true` for a tab limit: an integer of at least 1, or `Infinity` for none (ADR-0025). */
export function isTabLimit(value: unknown): value is number {
  return (
    value === Number.POSITIVE_INFINITY ||
    (typeof value === 'number' && Number.isInteger(value) && value >= 1)
  );
}

/** `true` for a USB vendor or product ID: an integer from `0x0000` to `0xffff`. */
export function isUsbId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff;
}

/**
 * `true` for one of the public statuses.
 *
 * Checked against the values themselves, not the type: a peer on another build may send a
 * status this one does not know, and that must be rejected rather than displayed.
 */
export function isStatus(value: unknown): value is SerialBrokerStatus {
  return (
    typeof value === 'string' && (Object.values(SerialBrokerStatus) as string[]).includes(value)
  );
}
