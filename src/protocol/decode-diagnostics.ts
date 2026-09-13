import { CONNECTION_STATES } from '../core/diagnostics.js';
import type { ParticipantDiagnostics } from '../core/diagnostics.js';

import { isFiniteNumber, isNonEmptyString, isRecord, isStatus, isTabLimit } from './guards.js';

/**
 * Validation of a diagnostics report arriving from another context (ADR-0018).
 *
 * A report is only ever displayed, never acted on - but it is displayed by code that reads it
 * field by field, and a field that is not what its type claims fails there, far from the bus.
 * So it is validated in full at the boundary, like every other message
 * (docs/guidelines/defensive-programming.md).
 *
 * Kept apart from `decode.ts` because it is a tree of shapes rather than a list of fields, and
 * it would double that file's length.
 */

const SERIAL_NUMBER_FIELDS = ['baudRate', 'dataBits', 'stopBits', 'bufferSize'] as const;
const SERIAL_TEXT_FIELDS = ['parity', 'flowControl'] as const;
const CONNECTION_NUMBER_FIELDS = [
  'initialDelayMs',
  'factor',
  'maxDelayMs',
  'jitter',
  'maxAttempts',
  'stableAfterMs',
  'openTimeoutMs',
  'writeTimeoutMs',
  'maxWriteChunkBytes',
] as const;
const LISTENER_FIELDS = ['onReceive', 'onSend', 'onError', 'onStatusChange'] as const;
const PENDING_WRITE_FIELDS = ['total', 'dispatched', 'started'] as const;
const CONNECTION_COUNT_FIELDS = ['attempt', 'queuedWrites', 'bytesReceived', 'bytesSent'] as const;

/** A number that may be infinite, as `maxAttempts` is by default, but never `NaN`. */
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && !Number.isNaN(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isOptionalTimestamp = (value: unknown): boolean =>
  value === undefined || isFiniteNumber(value);

const hasAll = (
  record: Record<string, unknown>,
  fields: readonly string[],
  check: (value: unknown) => boolean,
): boolean => fields.every((field) => check(record[field]));

/**
 * Checks that a value is a complete, well-typed participant report.
 *
 * @param value - Anything, from another context.
 * @returns `true` only if every field of the report, however deeply nested, has its declared
 *   type. Never throws.
 */
export function isParticipantDiagnostics(value: unknown): value is ParticipantDiagnostics {
  if (!isRecord(value)) {
    return false;
  }
  const configurations = value['configurations'];
  return (
    isNonEmptyString(value['clientId']) &&
    (value['transport'] === 'sharedworker' || value['transport'] === 'broadcastchannel') &&
    isFiniteNumber(value['protocolVersion']) &&
    isFiniteNumber(value['reportedAt']) &&
    Array.isArray(configurations) &&
    configurations.every(isConfigurationDiagnostics)
  );
}

function isConfigurationDiagnostics(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const lastErrorCode = value['lastErrorCode'];
  const connection = value['connection'];
  return (
    isNonEmptyString(value['name']) &&
    (value['role'] === 'owner' || value['role'] === 'participant') &&
    isStatus(value['status']) &&
    isFiniteNumber(value['statusSince']) &&
    (lastErrorCode === undefined || isNonEmptyString(lastErrorCode)) &&
    isSettings(value['settings']) &&
    isRecord(value['listeners']) &&
    hasAll(value['listeners'], LISTENER_FIELDS, isCount) &&
    isRecord(value['pendingWrites']) &&
    hasAll(value['pendingWrites'], PENDING_WRITE_FIELDS, isCount) &&
    (connection === undefined || isConnectionDiagnostics(connection))
  );
}

function isSettings(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const { device, serial, connection, encoding } = value;
  return (
    isDevice(device) &&
    isRecord(serial) &&
    hasAll(serial, SERIAL_NUMBER_FIELDS, isFiniteNumber) &&
    hasAll(serial, SERIAL_TEXT_FIELDS, isNonEmptyString) &&
    isRecord(connection) &&
    hasAll(connection, CONNECTION_NUMBER_FIELDS, isNumber) &&
    isRecord(encoding) &&
    isNonEmptyString(encoding['encoding']) &&
    typeof encoding['decodeText'] === 'boolean' &&
    typeof value['persist'] === 'boolean' &&
    isTabLimit(value['maxTabs'])
  );
}

function isDevice(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value['any'] === true) {
    return true;
  }
  return isCount(value['vendorId']) && isCount(value['productId']);
}

function isConnectionDiagnostics(value: unknown): boolean {
  return (
    isRecord(value) &&
    (CONNECTION_STATES as readonly unknown[]).includes(value['state']) &&
    hasAll(value, CONNECTION_COUNT_FIELDS, isCount) &&
    isOptionalTimestamp(value['nextAttemptAt']) &&
    isOptionalTimestamp(value['openedAt'])
  );
}
