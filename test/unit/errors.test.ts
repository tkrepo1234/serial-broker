import { describe, expect, it } from 'vitest';

import { REMEDIATION, SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import {
  describeUnknown,
  deserializeError,
  isSerializedError,
  isSerialBrokerError,
  SerialBrokerError,
  type SerializedSerialBrokerError,
} from '../../src/core/errors.js';
import { mapOpenError, mapReadError, mapRequestPortError } from '../../src/owner/serial-errors.js';
import { domException } from '../harness/fake-serial.js';

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

  it('classifies a code this version does not know as UNKNOWN, keeping the reported code', () => {
    // A tab on a later version may have a code this one lacks: adding one is not a protocol change.
    const fromLaterVersion = {
      ...new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'a future failure', {
        context: { detail: 1 },
        remediation: 'Do what the later version says.',
      }).toJSON(),
      code: 'SOME_FUTURE_CODE',
    };

    const revived = deserializeError(fromLaterVersion as SerializedSerialBrokerError);

    expect(revived.code).toBe(SerialBrokerErrorCode.UNKNOWN);
    expect(revived.context).toEqual({ detail: 1, reportedCode: 'SOME_FUTURE_CODE' });
    expect(revived.message).toBe('a future failure');
    expect(revived.remediation).toBe('Do what the later version says.');
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

  it('names the DOMException of a cause, and nothing else that carries a code', () => {
    const fromBrowser = new SerialBrokerError(SerialBrokerErrorCode.OPEN_FAILED, 'x', {
      cause: new DOMException('The port is already open', 'InvalidStateError'),
    });
    // Node's system errors, and many an application's own, carry a `code` of their own.
    const fromApplication = new SerialBrokerError(SerialBrokerErrorCode.LISTENER_THREW, 'x', {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    });

    expect(fromBrowser.toJSON().cause).toEqual({
      name: 'InvalidStateError',
      message: 'The port is already open',
      domExceptionName: 'InvalidStateError',
    });
    expect(fromApplication.toJSON().cause).toEqual({ name: 'Error', message: 'socket hang up' });
  });

  it('serializes a cause that cannot even be inspected', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const hostileName = Object.defineProperty(new Error('x'), 'name', {
      get(): never {
        throw new Error('no');
      },
    });

    // toJSON() is how the error reaches the other tabs; throwing there would lose it everywhere.
    for (const cause of [proxy, hostileName]) {
      const error = new SerialBrokerError(SerialBrokerErrorCode.LISTENER_THREW, 'x', { cause });
      expect(error.toJSON().cause?.name).toBe('NonError');
    }
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

  it('survives a revoked proxy, which cannot even be asked what it is', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(describeUnknown(proxy)).toBe('a value that cannot be described');
  });
});

describe('reporting hostile errors', () => {
  it('describes an error whose name is a Symbol or whose message getter throws', () => {
    const symbolName = Object.assign(new Error('x'), { name: Symbol('odd') as unknown as string });
    const throwing = new Error('x');
    Object.defineProperty(throwing, 'message', {
      get: () => {
        throw new Error('no');
      },
    });

    expect(describeUnknown(symbolName)).toBe('Symbol(odd): x');
    expect(describeUnknown(throwing)).toBe('[object Error]');
  });

  it('rejects a serialized error whose configName is not a string', () => {
    const serialized = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'x').toJSON();

    expect(isSerializedError({ ...serialized, configName: { evil: true } })).toBe(false);
    expect(isSerializedError({ ...serialized, configName: 'Reader' })).toBe(true);
  });
});

describe('SerialBrokerError built by application code', () => {
  it('has a remediation sentence for a code that is not in the table, whatever it is called', () => {
    for (const code of ['toString', '__proto__', 'constructor', 'NOT_A_CODE']) {
      const error = new SerialBrokerError(code as never, 'from a test double');

      expect(typeof error.remediation).toBe('string');
      expect(error.remediation).toBe(REMEDIATION.UNKNOWN);
    }
  });

  it('can be built with null options, as JavaScript may pass them', () => {
    const error = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'x', null as never);

    expect(error.remediation).toBe(REMEDIATION.WRITE_FAILED);
    expect(error.context).toEqual({});
  });
});

/**
 * The `DOMException` mapping table.
 *
 * ADR-0010 says the mapping is by name and never by message text, because message text differs
 * between Chromium versions. These tests are what keeps that true.
 */
describe('mapping platform failures', () => {
  const context = { configName: 'Reader', timestamp: 1234 };

  it.each([
    ['NetworkError', SerialBrokerErrorCode.OPEN_FAILED],
    ['InvalidStateError', SerialBrokerErrorCode.OPEN_FAILED],
    ['SecurityError', SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE],
    ['NotSupportedError', SerialBrokerErrorCode.OPEN_FAILED],
  ])('maps a %s from open() to %s', (name, expected) => {
    expect(mapOpenError(domException(name, 'x'), context).code).toBe(expected);
  });

  // The same name maps differently depending on the operation: SecurityError means "this context
  // may not use serial at all" when opening, and "you called me outside a user gesture" when
  // asking for a port. One table could not say both.
  it.each([
    ['SecurityError', SerialBrokerErrorCode.USER_GESTURE_REQUIRED],
    ['NotFoundError', SerialBrokerErrorCode.PERMISSION_DENIED],
  ])('maps a %s from requestPort() to %s', (name, expected) => {
    expect(mapRequestPortError(domException(name, 'x'), context).code).toBe(expected);
  });

  // A read rejects the same way whatever went wrong, so the name is the only thing that tells a
  // device that is gone from a line that is misbehaving - and they deserve opposite advice.
  it.each([
    ['NetworkError', SerialBrokerErrorCode.DEVICE_DISCONNECTED],
    ['ParityError', SerialBrokerErrorCode.READ_FAILED],
    ['FramingError', SerialBrokerErrorCode.READ_FAILED],
    ['BreakError', SerialBrokerErrorCode.READ_FAILED],
    ['BufferOverrunError', SerialBrokerErrorCode.READ_FAILED],
  ])('maps a %s from the read stream to %s', (name, expected) => {
    expect(mapReadError(domException(name, 'x'), context).code).toBe(expected);
  });

  it('falls back without losing the name, so an unmapped case is reportable', () => {
    const error = mapOpenError(domException('SomeFutureError', 'x'), context);

    expect(error.code).toBe(SerialBrokerErrorCode.OPEN_FAILED);
    expect(error.context.domExceptionName).toBe('SomeFutureError');
  });

  it('never maps on message text', () => {
    // A message that says "NetworkError" while the name says otherwise must not be believed.
    const misleading = domException('NotSupportedError', 'NetworkError: the device has been lost');

    expect(mapOpenError(misleading, context).code).toBe(SerialBrokerErrorCode.OPEN_FAILED);
  });

  it('passes a library error through unchanged', () => {
    const original = mapOpenError(domException('NetworkError', 'x'), context);

    expect(mapOpenError(original, context)).toBe(original);
  });

  it('maps something that is not an Error at all', () => {
    // An adapter or a polyfill can reject with a string. There is no name to key on, so the
    // fallback applies - but the caller still gets a library error rather than a bare string.
    const error = mapOpenError('the port exploded', context);

    expect(error.code).toBe(SerialBrokerErrorCode.OPEN_FAILED);
    expect(error.context.domExceptionName).toBeUndefined();
    expect(error.message).toContain('the port exploded');
  });

  it('does not take a name every object inherits for a mapped one', () => {
    const error = mapOpenError(domException('constructor', 'x'), context);

    expect(error.code).toBe(SerialBrokerErrorCode.OPEN_FAILED);
    expect(error.context.domExceptionName).toBe('constructor');
  });

  it('falls back for an error whose name is not a string or cannot be read', () => {
    const symbolName = domException('x', 'x');
    Object.defineProperty(symbolName, 'name', { value: Symbol('NetworkError') });
    const throwingName = domException('x', 'x');
    Object.defineProperty(throwingName, 'name', {
      get: () => {
        throw new Error('no name for you');
      },
    });

    // A Symbol cannot cross postMessage, and a throw here would escape the supervisor's failure
    // handling and leave the attempt stuck.
    for (const hostile of [symbolName, throwingName]) {
      const error = mapOpenError(hostile, context);
      expect(error.code).toBe(SerialBrokerErrorCode.OPEN_FAILED);
      expect(error.context.domExceptionName).toBeUndefined();
    }
  });

  it('keeps the original as the cause', () => {
    const underlying = domException('NetworkError', 'the device has been lost');

    expect(mapOpenError(underlying, context).cause).toBe(underlying);
  });

  it('carries the operation-specific detail it was given', () => {
    const error = mapOpenError(domException('NetworkError', 'x'), {
      ...context,
      extra: { attempt: 3 },
    });

    expect(error.context.attempt).toBe(3);
    expect(error.configName).toBe('Reader');
    expect(error.timestamp).toBe(1234);
  });
});
