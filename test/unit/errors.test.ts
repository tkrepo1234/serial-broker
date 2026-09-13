import { describe, expect, it } from 'vitest';

import { REMEDIATION, SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import {
  describeUnknown,
  deserializeError,
  isSerializedError,
  isSerialBrokerError,
  SerialBrokerError,
} from '../../src/core/errors.js';

describe('SerialBrokerError', () => {
  it('carries a remediation for every code, without being told one', () => {
    for (const code of Object.values(SerialBrokerErrorCode)) {
      const error = new SerialBrokerError(code, 'something happened');

      expect(error.remediation.length).toBeGreaterThan(20);
      expect(error.remediation).toBe(REMEDIATION[code]);
    }
  });

  it('never ships a remediation that says nothing', () => {
    // "Check your configuration" is not remediation. Every one of these has to tell the
    // developer what to actually do.
    for (const [code, remediation] of Object.entries(REMEDIATION)) {
      expect(remediation, `${code} has an unhelpfully vague remediation`).not.toMatch(
        /^(check|try) (your|again)/i,
      );
      expect(remediation.endsWith('.'), `${code} remediation is not a sentence`).toBe(true);
    }
  });

  it('marks the codes the library retries on its own as retryable', () => {
    expect(new SerialBrokerError(SerialBrokerErrorCode.DEVICE_DISCONNECTED, 'x').isRetryable).toBe(
      true,
    );
    expect(new SerialBrokerError(SerialBrokerErrorCode.INVALID_ARGUMENT, 'x').isRetryable).toBe(
      false,
    );
  });

  it('freezes its context', () => {
    const error = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'x', {
      context: { bytesWritten: 3 },
    });

    expect(Object.isFrozen(error.context)).toBe(true);
  });

  it('keeps the underlying error as a cause', () => {
    const underlying = new Error('the real problem');
    const error = new SerialBrokerError(SerialBrokerErrorCode.OPEN_FAILED, 'x', {
      cause: underlying,
    });

    expect(error.cause).toBe(underlying);
  });

  it('is recognisable through its own type guard', () => {
    expect(isSerialBrokerError(new SerialBrokerError(SerialBrokerErrorCode.UNKNOWN, 'x'))).toBe(
      true,
    );
    expect(isSerialBrokerError(new Error('x'))).toBe(false);
    expect(isSerialBrokerError('x')).toBe(false);
  });
});

describe('error serialization', () => {
  it('survives a round trip across a context boundary', () => {
    const original = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'the write failed', {
      configName: 'Reader',
      context: { bytesWritten: 7 },
      timestamp: 1234,
      cause: Object.assign(new Error('device gone'), { name: 'NetworkError' }),
    });

    // This is the path an error takes from the owning tab to every other tab. Structured
    // cloning drops subclass identity, so everything that matters travels as plain data.
    const revived = deserializeError(structuredClone(original.toJSON()));

    expect(revived).toBeInstanceOf(SerialBrokerError);
    expect(revived.code).toBe(original.code);
    expect(revived.message).toBe(original.message);
    expect(revived.configName).toBe('Reader');
    expect(revived.context).toEqual({ bytesWritten: 7 });
    expect(revived.remediation).toBe(original.remediation);
    expect(revived.isRetryable).toBe(original.isRetryable);
    expect(revived.timestamp).toBe(1234);
  });

  it('preserves the name and message of the underlying failure', () => {
    const original = new SerialBrokerError(SerialBrokerErrorCode.OPEN_FAILED, 'x', {
      cause: Object.assign(new Error('The device has been lost'), { name: 'NetworkError' }),
    });

    const revived = deserializeError(structuredClone(original.toJSON()));

    expect((revived.cause as Error).name).toBe('NetworkError');
    expect((revived.cause as Error).message).toBe('The device has been lost');
  });

  it('serializes a cause that is not an Error at all', () => {
    // Application code throws strings and plain objects. Losing the information entirely
    // because it was not an Error would be the wrong answer.
    const serialized = new SerialBrokerError(SerialBrokerErrorCode.LISTENER_THREW, 'x', {
      cause: { unexpected: true },
    }).toJSON();

    expect(serialized.cause?.name).toBe('NonError');
    expect(serialized.cause?.message).toContain('unexpected');
  });

  it('recognises a serialized error arriving from another context', () => {
    const serialized = new SerialBrokerError(SerialBrokerErrorCode.UNKNOWN, 'x').toJSON();

    expect(isSerializedError(structuredClone(serialized))).toBe(true);
    expect(isSerializedError({ code: 'UNKNOWN' })).toBe(false);
    expect(isSerializedError(null)).toBe(false);
    // Everything deserializeError reads is checked, so a bad message is dropped, not thrown on.
    expect(isSerializedError({ ...structuredClone(serialized), cause: null })).toBe(false);
    expect(isSerializedError({ ...structuredClone(serialized), message: undefined })).toBe(false);

    const wrapped = new SerialBrokerError(SerialBrokerErrorCode.RECONNECT_EXHAUSTED, 'gave up', {
      cause: new SerialBrokerError(SerialBrokerErrorCode.DEVICE_DISCONNECTED, 'gone'),
    });
    // This library's own error has an own `code` as well, and is still not a DOMException.
    expect(wrapped.toJSON().cause).not.toHaveProperty('domExceptionName');
  });

  it('is JSON-serialisable for a logging pipeline', () => {
    const error = new SerialBrokerError(SerialBrokerErrorCode.NOT_CONNECTED, 'x', {
      configName: 'Reader',
    });

    expect(() => JSON.stringify(error)).not.toThrow();
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({ code: 'NOT_CONNECTED' });
  });
});

describe('describeUnknown', () => {
  it.each([
    ['an Error', new Error('boom'), 'Error: boom'],
    ['a string', 'boom', 'boom'],
    ['a number', 42, '42'],
    ['undefined', undefined, 'undefined'],
    ['an object', { a: 1 }, '{"a":1}'],
  ])('describes %s', (_label, value, expected) => {
    expect(describeUnknown(value)).toBe(expected);
  });

  it('survives a circular object', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    // An application can and will throw one of these, and a stack overflow inside the error
    // path would take down the tab for a reason nobody could ever diagnose.
    expect(() => describeUnknown(circular)).not.toThrow();
  });

  it('survives an object with a throwing getter', () => {
    const hostile = {
      get value(): never {
        throw new Error('no');
      },
    };

    expect(() => describeUnknown(hostile)).not.toThrow();
  });
});
