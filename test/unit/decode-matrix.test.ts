import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { decodeMessage, describeDecodeFailure } from '../../src/protocol/decode.js';
import type { ProtocolMessageType } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';

import { sampleReport } from './fixtures/diagnostics-report.js';

const BASE = { v: PROTOCOL_VERSION, from: 'c-1', to: 'all' };
const ERROR_PAYLOAD = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'x').toJSON();

/** A valid instance of every message type, which every mutation below starts from. */
const VALID: Record<ProtocolMessageType, Record<string, unknown>> = {
  hello: { ...BASE, type: 'hello', secret: 's-1' },
  goodbye: { ...BASE, type: 'goodbye' },
  welcome: { ...BASE, to: 'c-2', type: 'welcome' },
  heartbeat: { ...BASE, type: 'heartbeat', configNames: ['Reader'], ownedConfigNames: [] },
  attach: { ...BASE, type: 'attach', configName: 'Reader' },
  detach: { ...BASE, type: 'detach', configName: 'Reader' },
  'owner-claimed': {
    ...BASE,
    type: 'owner-claimed',
    configName: 'Reader',
    term: 't-1',
    maxTabs: Number.POSITIVE_INFINITY,
  },
  'owner-released': { ...BASE, type: 'owner-released', configName: 'Reader', term: 't-1' },
  'status-request': { ...BASE, type: 'status-request', configName: 'Reader' },
  'write-request': {
    ...BASE,
    type: 'write-request',
    configName: 'Reader',
    requestId: 'w-1',
    payload: new Uint8Array([1]),
    term: 't-1',
  },
  'write-started': {
    ...BASE,
    type: 'write-started',
    configName: 'Reader',
    requestId: 'w-1',
    term: 't-1',
  },
  'write-result': {
    ...BASE,
    type: 'write-result',
    configName: 'Reader',
    requestId: 'w-1',
    ok: true,
    error: undefined,
    term: 't-1',
  },
  'data-received': {
    ...BASE,
    type: 'data-received',
    configName: 'Reader',
    payload: new Uint8Array([1]),
    text: 'a',
    timestamp: 1,
  },
  'data-sent': {
    ...BASE,
    type: 'data-sent',
    configName: 'Reader',
    payload: new Uint8Array([1]),
    originClientId: 'c-2',
    timestamp: 1,
  },
  status: {
    ...BASE,
    type: 'status',
    configName: 'Reader',
    status: 'open',
    maxTabs: Number.POSITIVE_INFINITY,
    term: 't-1',
    timestamp: 1,
  },
  error: { ...BASE, type: 'error', configName: 'Reader', error: ERROR_PAYLOAD, timestamp: 1 },
  'diagnostics-request': { ...BASE, type: 'diagnostics-request', requestId: 'd-1' },
  'worker-log': {
    ...BASE,
    to: 'c-2',
    type: 'worker-log',
    level: 'warn',
    message: 'refused a message from a port that has not said hello',
    fields: { event: 'worker.message-refused', reason: 'before-hello', limitValue: 8 },
  },
  'diagnostics-report': {
    ...BASE,
    to: 'c-2',
    type: 'diagnostics-report',
    requestId: 'd-1',
    report: sampleReport(),
  },
};

/** Every message type paired with the fields it must have to be accepted. */
const REQUIRED_FIELDS: Record<ProtocolMessageType, readonly string[]> = {
  // `secret` is optional: a hello on `BroadcastChannel` carries none (ADR-0028).
  hello: [],
  'worker-log': ['level', 'message', 'fields'],
  goodbye: [],
  welcome: [],
  heartbeat: ['configNames', 'ownedConfigNames'],
  attach: ['configName'],
  detach: ['configName'],
  'owner-claimed': ['configName', 'maxTabs'],
  'owner-released': ['configName'],
  'status-request': ['configName'],
  'write-request': ['configName', 'requestId', 'payload'],
  'write-started': ['configName', 'requestId'],
  'write-result': ['configName', 'requestId', 'ok'],
  'data-received': ['configName', 'payload', 'timestamp'],
  'data-sent': ['configName', 'payload', 'originClientId', 'timestamp'],
  status: ['configName', 'status', 'maxTabs', 'timestamp'],
  error: ['error', 'timestamp'],
  'diagnostics-request': ['requestId'],
  'diagnostics-report': ['requestId', 'report'],
};

const TYPES = Object.keys(VALID) as ProtocolMessageType[];

/**
 * The decoder against every message shape, exhaustively.
 *
 * A decoder is only worth having if it is complete: one message type whose required field is
 * not checked is one field that can be read as `undefined` deep inside the library, and the
 * symptom will appear a long way from the cause.
 */
describe('decode matrix', () => {
  it.each(TYPES)('accepts a well-formed %s', (type) => {
    expect(decodeMessage(VALID[type]).ok).toBe(true);
  });

  it.each(TYPES.flatMap((type) => REQUIRED_FIELDS[type].map((field) => [type, field] as const)))(
    'rejects a %s with no %s',
    (type, field) => {
      const message = { ...VALID[type] };
      delete message[field];

      expect(decodeMessage(message).ok).toBe(false);
    },
  );

  it.each(TYPES.flatMap((type) => REQUIRED_FIELDS[type].map((field) => [type, field] as const)))(
    'rejects a %s whose %s has the wrong type',
    (type, field) => {
      const message = { ...VALID[type], [field]: Symbol('wrong') as unknown };

      expect(decodeMessage(message).ok).toBe(false);
    },
  );

  it.each(TYPES)('names the message type when a %s is malformed', (type) => {
    if (REQUIRED_FIELDS[type].length === 0) {
      return;
    }
    const message = { ...VALID[type] };
    delete message[REQUIRED_FIELDS[type][0] as string];

    const result = decodeMessage(message);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(describeDecodeFailure(result.failure)).toContain(REQUIRED_FIELDS[type][0] as string);
    }
  });

  it('accepts a data-received message with no decoded text', () => {
    const message = { ...VALID['data-received'], text: undefined };

    expect(decodeMessage(message).ok).toBe(true);
  });

  it('rejects a data-received message whose text is not a string', () => {
    const message = { ...VALID['data-received'], text: 42 };

    expect(decodeMessage(message).ok).toBe(false);
  });

  it('accepts a failed write result carrying an error', () => {
    const message = { ...VALID['write-result'], ok: false, error: ERROR_PAYLOAD };

    expect(decodeMessage(message).ok).toBe(true);
  });

  it('accepts an error message that concerns no configuration', () => {
    const message = { ...VALID.error, configName: undefined };

    expect(decodeMessage(message).ok).toBe(true);
  });

  it.each([
    ['a number', 42],
    ['an empty string', ''],
    ['null', null],
  ])('rejects an error message whose configuration name is %s', (_label, configName) => {
    // Every receiver routes an error by its configuration name, so a name that is not one would be
    // dropped as concerning nobody - silently, rather than reported as malformed.
    const result = decodeMessage({ ...VALID.error, configName });

    expect(result).toEqual({
      ok: false,
      failure: { reason: 'malformed', type: 'error', field: 'configName' },
    });
  });

  it('rejects an error message whose error is not one of ours', () => {
    const message = { ...VALID.error, error: { message: 'just an object' } };

    expect(decodeMessage(message).ok).toBe(false);
  });

  it('rejects every message type when the protocol version differs', () => {
    for (const type of TYPES) {
      const result = decodeMessage({ ...VALID[type], v: PROTOCOL_VERSION + 1 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.failure.reason).toBe('version-mismatch');
        expect(describeDecodeFailure(result.failure)).toContain('protocol version');
      }
    }
  });

  it.each([
    ['a NaN timestamp', { ...VALID.status, timestamp: Number.NaN }],
    ['an infinite timestamp', { ...VALID.status, timestamp: Number.POSITIVE_INFINITY }],
    ['an empty configuration name', { ...VALID.attach, configName: '' }],
    ['an empty request id', { ...VALID['write-started'], requestId: '' }],
    ['an empty sender', { ...VALID.attach, from: '' }],
  ])('rejects %s', (_label, message) => {
    expect(decodeMessage(message).ok).toBe(false);
  });

  it('describes an unknown type', () => {
    const result = decodeMessage({ ...BASE, type: 'nonsense' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(describeDecodeFailure(result.failure)).toContain('nonsense');
    }
  });

  it('describes a value that is not an object', () => {
    const result = decodeMessage(7);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(describeDecodeFailure(result.failure)).toContain('not an object');
    }
  });

  it('rejects a message whose type is not a string', () => {
    expect(decodeMessage({ ...BASE, type: 99 }).ok).toBe(false);
  });
});
