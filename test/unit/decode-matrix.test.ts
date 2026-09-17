import { describe, expect, it } from 'vitest';

import { decodeMessage, describeDecodeFailure } from '../../src/protocol/decode.js';
import type { ProtocolMessageType } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';

import { ERROR_PAYLOAD, validMessages } from './fixtures/valid-messages.js';

const BASE = { v: PROTOCOL_VERSION, from: 'c-1', to: 'all' };

/** A valid instance of every message type, which every mutation below starts from. */
const VALID = validMessages();

/** Every message type paired with the fields it must have to be accepted. */
const REQUIRED_FIELDS: Record<ProtocolMessageType, readonly string[]> = {
  hello: ['configNames'],
  'worker-log': ['level', 'message', 'fields'],
  welcome: ['worker'],
  'owner-claimed': ['configName', 'maxTabs'],
  'owner-released': ['configName'],
  'status-request': ['configName', 'retry'],
  'write-request': ['configName', 'requestId', 'payload', 'term'],
  'write-ready': ['configName', 'requestId', 'term'],
  'write-approval': ['configName', 'requestId', 'term', 'approved'],
  'write-result': ['configName', 'requestId', 'ok'],
  'data-received': ['configName', 'payload', 'timestamp'],
  'data-sent': ['configName', 'payload', 'originClientId', 'timestamp'],
  status: ['configName', 'status', 'maxTabs', 'device', 'timestamp'],
  error: ['configName', 'error', 'timestamp'],
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

  it.each(TYPES)('names the missing field when a %s is malformed', (type) => {
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
    ['an empty configuration name', { ...VALID['status-request'], configName: '' }],
    ['an empty request id', { ...VALID['write-ready'], requestId: '' }],
    ['an empty sender', { ...VALID['status-request'], from: '' }],
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

  it.each([
    ['a primitive', 42],
    ['null', null],
    ['a string', 'hello'],
    ['an array', []],
  ])('rejects %s', (_label, raw) => {
    expect(decodeMessage(raw).ok).toBe(false);
  });

  it.each([
    ['no sender', { ...VALID['status-request'], from: undefined }],
    ['no recipient', { ...VALID['status-request'], to: undefined }],
  ])('rejects a message with %s', (_label, raw) => {
    expect(decodeMessage(raw).ok).toBe(false);
  });

  it('accepts an ArrayBuffer payload and normalises it to bytes', () => {
    const result = decodeMessage({
      ...VALID['write-request'],
      payload: new Uint8Array([1, 2, 3]).buffer,
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'write-request') {
      expect(result.message.payload).toBeInstanceOf(Uint8Array);
      expect([...result.message.payload]).toEqual([1, 2, 3]);
    }
  });

  it.each([
    'owner-claimed',
    'owner-released',
    'write-request',
    'write-ready',
    'write-approval',
    'status',
  ] as const)('rejects %s that names no term (ADR-0030)', (type) => {
    expect(decodeMessage({ ...VALID[type], term: undefined }).ok).toBe(false);
  });

  it.each([1, 'true', null, undefined])(
    'rejects a write approval whose answer is %s, not a boolean (ADR-0013)',
    (approved) => {
      // Read loosely, anything truthy would begin a write its issuer did not approve.
      expect(decodeMessage({ ...VALID['write-approval'], approved }).ok).toBe(false);
    },
  );

  it('accepts a write approval that refuses, and passes the refusal on', () => {
    const result = decodeMessage({ ...VALID['write-approval'], approved: false });

    expect(result.ok && result.message.type === 'write-approval' && result.message.approved).toBe(
      false,
    );
    expect(result.ok).toBe(true);
  });

  it('accepts a write result without a term, from a tab that never held the port', () => {
    expect(decodeMessage({ ...VALID['write-result'], term: undefined }).ok).toBe(true);
  });

  it('rejects a failed write result that carries no error', () => {
    // Accepting it would settle the caller's promise as a rejection with nothing to report.
    expect(decodeMessage({ ...VALID['write-result'], ok: false, error: undefined }).ok).toBe(false);
  });

  it('rejects a status message carrying a status that is not one', () => {
    expect(decodeMessage({ ...VALID.status, status: 'gloriously-open' }).ok).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    const hostile: Record<string, unknown> = { ...BASE, type: 'status-request' };
    hostile['self'] = hostile;
    Object.defineProperty(hostile, 'configName', {
      get() {
        throw new Error('no');
      },
      enumerable: true,
    });

    expect(() => decodeMessage(hostile)).not.toThrow();
    expect(decodeMessage(hostile).ok).toBe(false);
  });
});
