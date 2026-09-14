import { assertNever } from '../core/assert.js';
import type { ParticipantDiagnostics } from '../core/diagnostics.js';
import {
  describeUnknown,
  isSerializedError,
  type SerializedSerialBrokerError,
} from '../core/errors.js';
import type { LogFields } from '../core/types.js';

import { isParticipantDiagnostics } from './decode-diagnostics.js';
import {
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  isStatus,
  isTabLimit,
  isUsbId,
} from './guards.js';
import {
  exceedsStructureBudget,
  MAX_CONFIG_NAME_LENGTH,
  MAX_ERROR_CHARACTERS,
  MAX_ERROR_VALUES,
  MAX_HEARTBEAT_CONFIGURATIONS,
  MAX_IDENTIFIER_LENGTH,
  MAX_LOG_RECORD_CHARACTERS,
  MAX_LOG_RECORD_VALUES,
  MAX_PAYLOAD_BYTES,
  MAX_REPORT_CHARACTERS,
  MAX_REPORT_VALUES,
  MAX_REPORTED_CONFIGURATIONS,
  MAX_TEXT_LENGTH,
  type LimitName,
} from './limits.js';
import type {
  ClientId,
  MessageTarget,
  ProtocolMessage,
  RequestId,
  StatusDevice,
  TermId,
} from './messages.js';
import { isProtocolVersion, PROTOCOL_VERSION } from './version.js';

/**
 * The message-boundary validation layer.
 *
 * Anything arriving through `postMessage` or a `BroadcastChannel` is `unknown`: it may come
 * from an older build of this library, from an unrelated script that happens to use the same
 * channel name, or from a browser extension. Nothing is read from a message until it has
 * passed through here. See docs/guidelines/defensive-programming.md and ADR-0008.
 *
 * Validation alone lets a hostile sender make a context hold anything well-typed of any size, so
 * every field is also held to the limits in `limits.ts`. And an accepted message is rebuilt from its
 * declared fields: what the sender added travels no further - not into the application, and not
 * into the broker's copies for every other tab (SECURITY.md).
 */

/**
 * The longest message type quoted in a decode failure.
 *
 * A failure is logged, and its type is whatever the sender put there: quoting a string of any length
 * would let a sender write that much into every log record.
 */
const MAX_QUOTED_TYPE_LENGTH = 64;

/** Why a message was rejected. Reported at `warn` level, never thrown. */
export type DecodeFailure =
  | { readonly reason: 'not-an-object' }
  | {
      readonly reason: 'version-mismatch';
      /**
       * The sender's protocol version, or `undefined` when `v` is not a protocol version at all.
       *
       * Only a positive safe integer is passed on. Anything else the sender chose - an object, a
       * string of any length, a fraction - would be a new value for every message, and whoever
       * reports each version once would report it every time.
       */
      readonly theirVersion: number | undefined;
    }
  | { readonly reason: 'unknown-type'; readonly type: string }
  | { readonly reason: 'malformed'; readonly type: string; readonly field: string }
  | {
      readonly reason: 'limit-exceeded';
      readonly type: string;
      readonly field: string;
      /** The limit of `limits.ts` the field exceeds. */
      readonly limit: LimitName;
    };

/** Result of decoding one message. */
export type DecodeResult =
  | { readonly ok: true; readonly message: ProtocolMessage }
  | { readonly ok: false; readonly failure: DecodeFailure };

function fail(failure: DecodeFailure): DecodeResult {
  return { ok: false, failure };
}

/** Thrown inside the decoder only, to leave it from any depth; never escapes `decodeMessage`. */
class Rejection extends Error {
  constructor(readonly failure: DecodeFailure) {
    super(failure.reason);
  }
}

function malformed(type: string, field: string): never {
  throw new Rejection({ reason: 'malformed', type, field });
}

function exceeded(type: string, field: string, limit: LimitName): never {
  throw new Rejection({ reason: 'limit-exceeded', type, field, limit });
}

/** A value from the sender, quoted in a failure: a string of bounded length, whatever it was. */
function quoteType(value: unknown): string {
  if (typeof value !== 'string') {
    return `(${value === null ? 'null' : typeof value})`;
  }
  return value.length > MAX_QUOTED_TYPE_LENGTH
    ? `${value.slice(0, MAX_QUOTED_TYPE_LENGTH)}...`
    : value;
}

/**
 * Reads the raw message, one declared field at a time, each checked as it is read.
 *
 * Every reader either returns the field in its declared type, or throws a {@link Rejection} naming
 * the field and why. So a message is either rebuilt entirely from checked fields, or rejected.
 */
class FieldReader {
  constructor(
    private readonly raw: Record<string, unknown>,
    readonly type: string,
  ) {}

  /** A string of at most `limit` characters: a name or an identifier. */
  #boundedString(field: string, maxLength: number, limit: LimitName): string {
    const value = this.raw[field];
    if (!isNonEmptyString(value)) {
      return malformed(this.type, field);
    }
    if (value.length > maxLength) {
      return exceeded(this.type, field, limit);
    }
    return value;
  }

  identifier(field: string): string {
    return this.#boundedString(field, MAX_IDENTIFIER_LENGTH, 'MAX_IDENTIFIER_LENGTH');
  }

  optionalIdentifier(field: string): string | undefined {
    return this.raw[field] === undefined ? undefined : this.identifier(field);
  }

  configName(field = 'configName'): string {
    return this.#boundedString(field, MAX_CONFIG_NAME_LENGTH, 'MAX_CONFIG_NAME_LENGTH');
  }

  optionalConfigName(): string | undefined {
    // Optional, but routed on when present: a name that is not one would be dropped by every
    // receiver as belonging to no configuration, without anyone learning why.
    return this.raw['configName'] === undefined ? undefined : this.configName();
  }

  target(): MessageTarget {
    return this.identifier('to') as MessageTarget;
  }

  nameList(field: string): readonly string[] {
    const value = this.raw[field];
    if (!Array.isArray(value)) {
      return malformed(this.type, field);
    }
    if (value.length > MAX_HEARTBEAT_CONFIGURATIONS) {
      return exceeded(this.type, field, 'MAX_HEARTBEAT_CONFIGURATIONS');
    }
    const names: string[] = [];
    for (const name of value as readonly unknown[]) {
      if (!isNonEmptyString(name)) {
        return malformed(this.type, field);
      }
      if (name.length > MAX_CONFIG_NAME_LENGTH) {
        return exceeded(this.type, field, 'MAX_CONFIG_NAME_LENGTH');
      }
      names.push(name);
    }
    return names;
  }

  /**
   * A payload, normalised to a `Uint8Array` that spans its own buffer and nothing more.
   *
   * Payloads arrive as `Uint8Array` through structured cloning. A sender on a different build could
   * send something else entirely, and a plain `ArrayBuffer` is a realistic near-miss, so both are
   * accepted. A view is copied when it does not span exactly its own, unshared buffer: cloning a view
   * clones all of its buffer, and a one-byte view of a 100 MB buffer must not keep the 100 MB alive in
   * whoever holds the payload.
   */
  payload(): Uint8Array {
    const value = this.raw['payload'];
    let bytes: Uint8Array;
    if (value instanceof Uint8Array) {
      bytes = value;
    } else if (value instanceof ArrayBuffer) {
      bytes = new Uint8Array(value);
    } else {
      return malformed(this.type, 'payload');
    }
    if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
      return exceeded(this.type, 'payload', 'MAX_PAYLOAD_BYTES');
    }
    const spansItsBuffer =
      bytes.byteOffset === 0 &&
      bytes.buffer instanceof ArrayBuffer &&
      bytes.buffer.byteLength === bytes.byteLength;
    return spansItsBuffer ? bytes : bytes.slice();
  }

  timestamp(): number {
    const value = this.raw['timestamp'];
    return isFiniteNumber(value) ? value : malformed(this.type, 'timestamp');
  }

  optionalText(): string | undefined {
    const value = this.raw['text'];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      return malformed(this.type, 'text');
    }
    return value.length > MAX_TEXT_LENGTH ? exceeded(this.type, 'text', 'MAX_TEXT_LENGTH') : value;
  }

  boolean(field: string): boolean {
    const value = this.raw[field];
    return typeof value === 'boolean' ? value : malformed(this.type, field);
  }

  /**
   * The device of the tab sending a status, rebuilt from its kind and, for USB, its two IDs.
   *
   * A tab in auto mode adopts what this says (ADR-0036), so a kind this build does not know, or
   * an ID outside the USB range, is rejected rather than passed on for a filter nobody could have
   * configured.
   */
  device(): StatusDevice {
    const value = this.raw['device'];
    if (!isRecord(value)) {
      return malformed(this.type, 'device');
    }
    const kind = value['kind'];
    switch (kind) {
      case 'usb': {
        const vendorId = value['vendorId'];
        const productId = value['productId'];
        if (!isUsbId(vendorId) || !isUsbId(productId)) {
          return malformed(this.type, 'device');
        }
        return { kind, vendorId, productId };
      }
      case 'non-usb':
      case 'any':
      case 'auto':
        return { kind };
      default:
        return malformed(this.type, 'device');
    }
  }

  error(): SerializedSerialBrokerError {
    const value = this.raw['error'];
    // Bounded before the shape is checked, so that checking costs no more than the budget.
    if (typeof value === 'object' && value !== null) {
      const excess = exceedsStructureBudget(value, {
        values: MAX_ERROR_VALUES,
        characters: MAX_ERROR_CHARACTERS,
      });
      if (excess !== undefined) {
        const limit = excess === 'values' ? 'MAX_ERROR_VALUES' : 'MAX_ERROR_CHARACTERS';
        return exceeded(this.type, 'error', limit);
      }
    }
    return isSerializedError(value) ? value : malformed(this.type, 'error');
  }

  /**
   * The level of a forwarded worker record. Only the two levels the worker forwards are accepted.
   */
  logLevel(): 'warn' | 'error' {
    const value = this.raw['level'];
    return value === 'warn' || value === 'error' ? value : malformed(this.type, 'level');
  }

  /** The text of a forwarded worker record: a sentence the worker wrote, bounded like its fields. */
  logMessage(): string {
    const value = this.raw['message'];
    if (typeof value !== 'string' || value.length === 0) {
      return malformed(this.type, 'message');
    }
    return value.length > MAX_LOG_RECORD_CHARACTERS
      ? exceeded(this.type, 'message', 'MAX_LOG_RECORD_CHARACTERS')
      : value;
  }

  /**
   * The fields of a forwarded worker record: a flat object of strings, finite numbers and booleans.
   *
   * A record is written to a logger and read by nobody else, so nothing in it has to be structure.
   * Rejecting everything else - objects, arrays, cycles, functions - keeps what an application's
   * logger is handed as small and as plain as the fields the library writes itself. The object is
   * rebuilt, so a `__proto__` key is an own property here and changes nothing.
   *
   * @param messageCharacters - What the record's message already spends of the budget the two share,
   *   so that `MAX_LOG_RECORD_CHARACTERS` bounds the record and not each of its halves.
   */
  logFields(messageCharacters: number): LogFields {
    const value = this.raw['fields'];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return malformed(this.type, 'fields');
    }
    const record = value as Record<string, unknown>;
    // Collected key by key, not through `Object.entries`: a `fields` of a million keys is as easy to
    // post as one of three, and materialising it before applying the bound would make reading the
    // message cost what the bound exists to prevent (`limits.ts`, StructureBudget).
    const entries: [string, unknown][] = [];
    for (const key in record) {
      if (!Object.hasOwn(record, key)) {
        continue;
      }
      if (entries.length === MAX_LOG_RECORD_VALUES) {
        return exceeded(this.type, 'fields', 'MAX_LOG_RECORD_VALUES');
      }
      entries.push([key, record[key]]);
    }
    let characters = messageCharacters;
    for (const [key, entry] of entries) {
      if (typeof entry === 'string') {
        characters += key.length + entry.length;
      } else if (typeof entry === 'boolean' || isFiniteNumber(entry)) {
        characters += key.length;
      } else {
        return malformed(this.type, 'fields');
      }
      if (characters > MAX_LOG_RECORD_CHARACTERS) {
        return exceeded(this.type, 'fields', 'MAX_LOG_RECORD_CHARACTERS');
      }
    }
    // The three fields every logger reads by name have to be what a logger expects them to be.
    for (const named of ['event', 'clientId', 'configName']) {
      const field = record[named];
      if (field !== undefined && typeof field !== 'string') {
        return malformed(this.type, 'fields');
      }
    }
    return Object.fromEntries(entries);
  }

  report(): ParticipantDiagnostics {
    const value = this.raw['report'];
    if (typeof value === 'object' && value !== null) {
      const excess = exceedsStructureBudget(value, {
        values: MAX_REPORT_VALUES,
        characters: MAX_REPORT_CHARACTERS,
      });
      if (excess !== undefined) {
        const limit = excess === 'values' ? 'MAX_REPORT_VALUES' : 'MAX_REPORT_CHARACTERS';
        return exceeded(this.type, 'report', limit);
      }
      // Counted on its own: a report of many small configurations stays within the value budget, and
      // each configuration is still one more row an observer shows.
      const configurations = (value as Record<string, unknown>)['configurations'];
      if (Array.isArray(configurations) && configurations.length > MAX_REPORTED_CONFIGURATIONS) {
        return exceeded(this.type, 'report', 'MAX_REPORTED_CONFIGURATIONS');
      }
    }
    return isParticipantDiagnostics(value) ? value : malformed(this.type, 'report');
  }
}

/**
 * Validates an incoming message.
 *
 * @param raw - The value from `event.data`. Entirely untrusted.
 * @returns The typed message, rebuilt from its declared fields only, or the reason it was rejected.
 *   Never throws: a hostile message must not be able to break the receive path.
 */
export function decodeMessage(raw: unknown): DecodeResult {
  try {
    return { ok: true, message: decodeChecked(raw) };
  } catch (error) {
    if (error instanceof Rejection) {
      return fail(error.failure);
    }
    // The contract is absolute: a message must never be able to break the receive path, and
    // "reading a field cannot throw" is an assumption, not a fact. Structured cloning does not
    // carry getters today, so this is unreachable through the supported transports - which is
    // exactly why it is worth two lines rather than an argument.
    return fail({ reason: 'malformed', type: 'unreadable', field: describeUnknown(error) });
  }
}

function decodeChecked(raw: unknown): ProtocolMessage {
  if (!isRecord(raw)) {
    throw new Rejection({ reason: 'not-an-object' });
  }

  const version = raw['v'];
  if (version !== PROTOCOL_VERSION) {
    throw new Rejection({
      reason: 'version-mismatch',
      theirVersion: isProtocolVersion(version) ? version : undefined,
    });
  }

  const quotedType = quoteType(raw['type']);
  const envelope = new FieldReader(raw, quotedType);
  const from = envelope.identifier('from') as ClientId;
  const to = envelope.target();

  const type = raw['type'];
  if (typeof type !== 'string') {
    throw new Rejection({ reason: 'unknown-type', type: quotedType });
  }

  const read = new FieldReader(raw, type);
  const v = PROTOCOL_VERSION;

  switch (type) {
    case 'hello':
      // Optional: a `hello` on `BroadcastChannel` carries none, because every context would hear it
      // (ADR-0028). The worker refuses such a `hello` on a port; nothing else reads it.
      return { type, v, from, to, secret: read.optionalIdentifier('secret') };

    case 'welcome':
    case 'goodbye':
      return { type, v, from, to };

    case 'worker-log': {
      // One character budget for the record, so what the message spends of it the fields no longer
      // have: read the message first and carry its length into them.
      const level = read.logLevel();
      const message = read.logMessage();
      return { type, v, from, to, level, message, fields: read.logFields(message.length) };
    }

    case 'heartbeat':
      return {
        type,
        v,
        from,
        to,
        configNames: read.nameList('configNames'),
        ownedConfigNames: read.nameList('ownedConfigNames'),
      };

    case 'attach':
    case 'detach':
    case 'status-request':
      return { type, v, from, to, configName: read.configName() };

    case 'owner-claimed': {
      const configName = read.configName();
      const term = read.identifier('term') as TermId;
      const maxTabs = raw['maxTabs'];
      if (!isTabLimit(maxTabs)) {
        return malformed(type, 'maxTabs');
      }
      return { type, v, from, to, configName, term, maxTabs };
    }

    case 'owner-released':
      return {
        type,
        v,
        from,
        to,
        configName: read.configName(),
        term: read.identifier('term') as TermId,
      };

    case 'write-request':
      return {
        type,
        v,
        from,
        to,
        configName: read.configName(),
        requestId: read.identifier('requestId') as RequestId,
        payload: read.payload(),
        term: read.identifier('term') as TermId,
      };

    case 'write-started':
      return {
        type,
        v,
        from,
        to,
        configName: read.configName(),
        requestId: read.identifier('requestId') as RequestId,
        term: read.identifier('term') as TermId,
      };

    case 'write-result': {
      const configName = read.configName();
      const requestId = read.identifier('requestId') as RequestId;
      const ok = read.boolean('ok');
      // A failed result without an error would leave the caller's promise rejected with nothing to
      // report, which is worse than dropping the message. A successful one carries none: an error
      // there would be nothing anyone reads, only something the broker copies.
      const error = ok ? undefined : read.error();
      // Optional: a tab that never held the port has no term to answer with.
      const term = read.optionalIdentifier('term') as TermId | undefined;
      return { type, v, from, to, configName, requestId, ok, error, term };
    }

    case 'data-received':
      return {
        type,
        v,
        from,
        to,
        configName: read.configName(),
        payload: read.payload(),
        timestamp: read.timestamp(),
        text: read.optionalText(),
      };

    case 'data-sent':
      return {
        type,
        v,
        from,
        to,
        configName: read.configName(),
        payload: read.payload(),
        originClientId: read.identifier('originClientId') as ClientId,
        timestamp: read.timestamp(),
      };

    case 'status': {
      const configName = read.configName();
      const status = raw['status'];
      if (!isStatus(status)) {
        return malformed(type, 'status');
      }
      const maxTabs = raw['maxTabs'];
      if (!isTabLimit(maxTabs)) {
        return malformed(type, 'maxTabs');
      }
      const device = read.device();
      const term = read.identifier('term') as TermId;
      return {
        type,
        v,
        from,
        to,
        configName,
        status,
        maxTabs,
        device,
        term,
        timestamp: read.timestamp(),
      };
    }

    case 'diagnostics-request':
      return { type, v, from, to, requestId: read.identifier('requestId') as RequestId };

    case 'diagnostics-report':
      return {
        type,
        v,
        from,
        to,
        requestId: read.identifier('requestId') as RequestId,
        report: read.report(),
      };

    case 'error': {
      const configName = read.optionalConfigName();
      const error = read.error();
      return { type, v, from, to, configName, error, timestamp: read.timestamp() };
    }

    default:
      throw new Rejection({ reason: 'unknown-type', type: quotedType });
  }
}

/** Renders a decode failure as a log message. */
export function describeDecodeFailure(failure: DecodeFailure): string {
  switch (failure.reason) {
    case 'not-an-object':
      return 'message was not an object';
    case 'version-mismatch':
      return failure.theirVersion === undefined
        ? `message carries no protocol version, where ${String(PROTOCOL_VERSION)} was expected`
        : `protocol version ${String(failure.theirVersion)} does not match ${String(PROTOCOL_VERSION)}`;
    case 'unknown-type':
      return `unknown message type ${failure.type}`;
    case 'malformed':
      return `message "${failure.type}" has an invalid "${failure.field}" field`;
    case 'limit-exceeded':
      return `message "${failure.type}" exceeds ${failure.limit} in its "${failure.field}" field`;
    default:
      return assertNever(failure, 'decode failure reason');
  }
}
