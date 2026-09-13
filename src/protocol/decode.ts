import { assertNever } from '../core/assert.js';
import { isSerializedError } from '../core/errors.js';

import { isParticipantDiagnostics } from './decode-diagnostics.js';
import { isFiniteNumber, isNonEmptyString, isRecord, isStatus, isTabLimit } from './guards.js';
import type { ClientId, MessageTarget, ProtocolMessage, RequestId } from './messages.js';
import { PROTOCOL_VERSION } from './version.js';

/**
 * The message-boundary validation layer.
 *
 * Anything arriving through `postMessage` or a `BroadcastChannel` is `unknown`: it may come
 * from an older build of this library, from an unrelated script that happens to use the same
 * channel name, or from a browser extension. Nothing is read from a message until it has
 * passed through here. See docs/guidelines/defensive-programming.md and ADR-0008.
 */

/** Why a message was rejected. Reported at `warn` level, never thrown. */
export type DecodeFailure =
  | { readonly reason: 'not-an-object' }
  | { readonly reason: 'version-mismatch'; readonly theirVersion: unknown }
  | { readonly reason: 'unknown-type'; readonly type: unknown }
  | { readonly reason: 'malformed'; readonly type: string; readonly field: string };

/** Result of decoding one message. */
export type DecodeResult =
  | { readonly ok: true; readonly message: ProtocolMessage }
  | { readonly ok: false; readonly failure: DecodeFailure };

function fail(failure: DecodeFailure): DecodeResult {
  return { ok: false, failure };
}

function malformed(type: string, field: string): DecodeResult {
  return fail({ reason: 'malformed', type, field });
}

/**
 * Accepts a message as it arrived, once every field its type declares has been checked.
 *
 * Only messages carrying a payload are rebuilt instead, because their payload may need
 * normalising (see {@link asBytes}).
 */
function accepted(raw: Record<string, unknown>): DecodeResult {
  return { ok: true, message: raw as unknown as ProtocolMessage };
}

const isNameList = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

/**
 * Payloads arrive as `Uint8Array` through structured cloning.
 *
 * A sender on a different build could send something else entirely, and a plain `ArrayBuffer`
 * is a realistic near-miss, so both are accepted and normalised rather than rejected.
 */
function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return undefined;
}

/**
 * Validates an incoming message.
 *
 * @param raw - The value from `event.data`. Entirely untrusted.
 * @returns The typed message, or the reason it was rejected. Never throws: a hostile message
 *   must not be able to break the receive path.
 */
export function decodeMessage(raw: unknown): DecodeResult {
  try {
    return decodeChecked(raw);
  } catch (error) {
    // The contract is absolute: a message must never be able to break the receive path, and
    // "reading a field cannot throw" is an assumption, not a fact. Structured cloning does not
    // carry getters today, so this is unreachable through the supported transports - which is
    // exactly why it is worth two lines rather than an argument.
    return fail({ reason: 'malformed', type: 'unreadable', field: String(error) });
  }
}

function decodeChecked(raw: unknown): DecodeResult {
  if (!isRecord(raw)) {
    return fail({ reason: 'not-an-object' });
  }

  if (raw['v'] !== PROTOCOL_VERSION) {
    return fail({ reason: 'version-mismatch', theirVersion: raw['v'] });
  }

  if (!isNonEmptyString(raw['from'])) {
    return malformed(String(raw['type']), 'from');
  }

  if (!isNonEmptyString(raw['to'])) {
    return malformed(String(raw['type']), 'to');
  }

  const type = raw['type'];
  if (typeof type !== 'string') {
    return fail({ reason: 'unknown-type', type });
  }

  switch (type) {
    case 'hello':
    case 'welcome':
    case 'goodbye':
      return accepted(raw);

    case 'heartbeat':
      if (!isNameList(raw['configNames'])) {
        return malformed(type, 'configNames');
      }
      return isNameList(raw['ownedConfigNames'])
        ? accepted(raw)
        : malformed(type, 'ownedConfigNames');

    case 'attach':
    case 'detach':
    case 'owner-claimed':
    case 'owner-released':
    case 'status-request':
      return isNonEmptyString(raw['configName']) ? accepted(raw) : malformed(type, 'configName');

    case 'write-request': {
      if (!isNonEmptyString(raw['configName'])) {
        return malformed(type, 'configName');
      }
      if (!isNonEmptyString(raw['requestId'])) {
        return malformed(type, 'requestId');
      }
      const payload = asBytes(raw['payload']);
      if (payload === undefined) {
        return malformed(type, 'payload');
      }
      return {
        ok: true,
        message: {
          type: 'write-request',
          v: PROTOCOL_VERSION,
          from: raw['from'] as ClientId,
          to: raw['to'] as MessageTarget,
          configName: raw['configName'],
          requestId: raw['requestId'] as RequestId,
          payload,
        },
      };
    }

    case 'write-started':
      if (!isNonEmptyString(raw['configName'])) {
        return malformed(type, 'configName');
      }
      return isNonEmptyString(raw['requestId']) ? accepted(raw) : malformed(type, 'requestId');

    case 'write-result': {
      if (!isNonEmptyString(raw['configName'])) {
        return malformed(type, 'configName');
      }
      if (!isNonEmptyString(raw['requestId'])) {
        return malformed(type, 'requestId');
      }
      if (typeof raw['ok'] !== 'boolean') {
        return malformed(type, 'ok');
      }
      // A failed result without an error would leave the caller's promise rejected with
      // nothing to report, which is worse than dropping the message.
      if (!raw['ok'] && !isSerializedError(raw['error'])) {
        return malformed(type, 'error');
      }
      return accepted(raw);
    }

    case 'data-received': {
      if (!isNonEmptyString(raw['configName'])) {
        return malformed(type, 'configName');
      }
      const payload = asBytes(raw['payload']);
      if (payload === undefined) {
        return malformed(type, 'payload');
      }
      if (!isFiniteNumber(raw['timestamp'])) {
        return malformed(type, 'timestamp');
      }
      const text = raw['text'];
      if (text !== undefined && typeof text !== 'string') {
        return malformed(type, 'text');
      }
      return {
        ok: true,
        message: {
          type: 'data-received',
          v: PROTOCOL_VERSION,
          from: raw['from'] as ClientId,
          to: raw['to'] as MessageTarget,
          configName: raw['configName'],
          payload,
          text,
          timestamp: raw['timestamp'],
        },
      };
    }

    case 'data-sent': {
      if (!isNonEmptyString(raw['configName'])) {
        return malformed(type, 'configName');
      }
      const payload = asBytes(raw['payload']);
      if (payload === undefined) {
        return malformed(type, 'payload');
      }
      if (!isNonEmptyString(raw['originClientId'])) {
        return malformed(type, 'originClientId');
      }
      if (!isFiniteNumber(raw['timestamp'])) {
        return malformed(type, 'timestamp');
      }
      return {
        ok: true,
        message: {
          type: 'data-sent',
          v: PROTOCOL_VERSION,
          from: raw['from'] as ClientId,
          to: raw['to'] as MessageTarget,
          configName: raw['configName'],
          payload,
          originClientId: raw['originClientId'] as ClientId,
          timestamp: raw['timestamp'],
        },
      };
    }

    case 'status':
      if (!isNonEmptyString(raw['configName'])) {
        return malformed(type, 'configName');
      }
      if (!isStatus(raw['status'])) {
        return malformed(type, 'status');
      }
      if (!isTabLimit(raw['maxTabs'])) {
        return malformed(type, 'maxTabs');
      }
      return isFiniteNumber(raw['timestamp']) ? accepted(raw) : malformed(type, 'timestamp');

    case 'diagnostics-request':
      return isNonEmptyString(raw['requestId']) ? accepted(raw) : malformed(type, 'requestId');

    case 'diagnostics-report':
      if (!isNonEmptyString(raw['requestId'])) {
        return malformed(type, 'requestId');
      }
      return isParticipantDiagnostics(raw['report']) ? accepted(raw) : malformed(type, 'report');

    case 'error':
      // Optional, but routed on when present: a name that is not one would be dropped by every
      // receiver as belonging to no configuration, without anyone learning why.
      if (raw['configName'] !== undefined && !isNonEmptyString(raw['configName'])) {
        return malformed(type, 'configName');
      }
      if (!isSerializedError(raw['error'])) {
        return malformed(type, 'error');
      }
      return isFiniteNumber(raw['timestamp']) ? accepted(raw) : malformed(type, 'timestamp');

    default:
      return fail({ reason: 'unknown-type', type });
  }
}

/** Renders a decode failure as a log message. */
export function describeDecodeFailure(failure: DecodeFailure): string {
  switch (failure.reason) {
    case 'not-an-object':
      return 'message was not an object';
    case 'version-mismatch':
      return `protocol version ${String(failure.theirVersion)} does not match ${String(PROTOCOL_VERSION)}`;
    case 'unknown-type':
      return `unknown message type ${String(failure.type)}`;
    case 'malformed':
      return `message "${failure.type}" has an invalid "${failure.field}" field`;
    default:
      return assertNever(failure, 'decode failure reason');
  }
}
