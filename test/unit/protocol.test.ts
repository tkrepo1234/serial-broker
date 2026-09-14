import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { decodeMessage, describeDecodeFailure } from '../../src/protocol/decode.js';
import type { ClientId, RequestId } from '../../src/protocol/messages.js';
import { brokerChannelName, ownerLockName, PROTOCOL_VERSION } from '../../src/protocol/version.js';

const ENVELOPE = { v: PROTOCOL_VERSION, from: 'c-1' as ClientId, to: 'all' as const };

/**
 * The message boundary.
 *
 * Everything arriving here is `unknown`: it may come from an older build, from an unrelated
 * script that happens to use the same channel name, or from a browser extension. Nothing may
 * be read from a message until it has passed through the decoder, and the decoder must never
 * throw - a hostile message that breaks the receive path would take the library down in every
 * tab at once (ADR-0008).
 */
describe('decodeMessage', () => {
  it('accepts a well-formed message', () => {
    const result = decodeMessage({ ...ENVELOPE, type: 'attach', configName: 'Reader' });

    expect(result.ok).toBe(true);
  });

  it('rejects a message from a different protocol version', () => {
    const result = decodeMessage({ ...ENVELOPE, v: PROTOCOL_VERSION + 1, type: 'attach' });

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.failure.reason).toBe('version-mismatch');
  });

  it.each([
    ['a primitive', 42],
    ['null', null],
    ['a string', 'hello'],
    ['an array', []],
  ])('rejects %s', (_label, raw) => {
    const result = decodeMessage(raw);

    expect(result.ok).toBe(false);
  });

  it('rejects an unknown message type', () => {
    const result = decodeMessage({ ...ENVELOPE, type: 'take-over-the-port' });

    expect(result.ok ? undefined : result.failure.reason).toBe('unknown-type');
  });

  it.each([
    ['no sender', { ...ENVELOPE, from: undefined, type: 'attach', configName: 'R' }],
    ['no recipient', { ...ENVELOPE, to: undefined, type: 'attach', configName: 'R' }],
    ['no configuration', { ...ENVELOPE, type: 'attach' }],
    ['a numeric configuration name', { ...ENVELOPE, type: 'attach', configName: 7 }],
  ])('rejects a message with %s', (_label, raw) => {
    expect(decodeMessage(raw).ok).toBe(false);
  });

  it('rejects a write request whose payload is not bytes', () => {
    const result = decodeMessage({
      ...ENVELOPE,
      type: 'write-request',
      configName: 'Reader',
      requestId: 'w-1',
      payload: 'not bytes',
    });

    expect(result.ok).toBe(false);
  });

  it('accepts an ArrayBuffer payload and normalises it to bytes', () => {
    const result = decodeMessage({
      ...ENVELOPE,
      type: 'write-request',
      configName: 'Reader',
      requestId: 'w-1' as RequestId,
      payload: new Uint8Array([1, 2, 3]).buffer,
      term: 't-1',
    });

    expect(result.ok).toBe(true);
    if (result.ok && result.message.type === 'write-request') {
      expect(result.message.payload).toBeInstanceOf(Uint8Array);
      expect([...result.message.payload]).toEqual([1, 2, 3]);
    }
  });

  it.each([
    ['an ownership claim', { type: 'owner-claimed', configName: 'Reader' }],
    ['an ownership release', { type: 'owner-released', configName: 'Reader' }],
    ['a write start', { type: 'write-started', configName: 'Reader', requestId: 'w-1' }],
    [
      'a status',
      { type: 'status', configName: 'Reader', status: 'open', maxTabs: 1, timestamp: 1 },
    ],
  ])('rejects %s that names no term (ADR-0026)', (_label, fields) => {
    expect(decodeMessage({ ...ENVELOPE, ...fields }).ok).toBe(false);
  });

  it('accepts a write result without a term, from a tab that never held the port', () => {
    const result = decodeMessage({
      ...ENVELOPE,
      type: 'write-result',
      configName: 'Reader',
      requestId: 'w-1',
      ok: true,
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a failed write result that carries no error', () => {
    // Accepting it would settle the caller's promise as a rejection with nothing to report.
    const result = decodeMessage({
      ...ENVELOPE,
      type: 'write-result',
      configName: 'Reader',
      requestId: 'w-1',
      ok: false,
    });

    expect(result.ok).toBe(false);
  });

  it('accepts a failed write result that carries one', () => {
    const result = decodeMessage({
      ...ENVELOPE,
      type: 'write-result',
      configName: 'Reader',
      requestId: 'w-1',
      ok: false,
      error: new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'x').toJSON(),
    });

    expect(result.ok).toBe(true);
  });

  it('rejects a status message carrying a status that is not one', () => {
    const result = decodeMessage({
      ...ENVELOPE,
      type: 'status',
      configName: 'Reader',
      status: 'gloriously-open',
      timestamp: 1,
    });

    expect(result.ok).toBe(false);
  });

  it('never throws, whatever it is handed', () => {
    const hostile: Record<string, unknown> = { ...ENVELOPE, type: 'attach' };
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

  it('describes why a message was rejected', () => {
    const result = decodeMessage({ ...ENVELOPE, type: 'attach' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(describeDecodeFailure(result.failure)).toContain('configName');
    }
  });
});

describe('namespaced names', () => {
  it('puts the protocol version in the lock name', () => {
    // Two incompatible versions must not contend for the same lock, or they would take turns
    // owning a port they cannot talk to each other about (ADR-0008).
    expect(ownerLockName('Reader')).toContain(`v${String(PROTOCOL_VERSION)}`);
    expect(ownerLockName('Reader')).toContain('Reader');
  });

  it('puts the protocol version in the broker name', () => {
    expect(brokerChannelName()).toContain(`v${String(PROTOCOL_VERSION)}`);
  });

  it('keeps configurations apart', () => {
    expect(ownerLockName('A')).not.toBe(ownerLockName('B'));
  });
});
