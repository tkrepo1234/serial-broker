import { describe, expect, it, vi } from 'vitest';

import { assertNever } from '../../src/core/assert.js';
import { copyBytes, toHex } from '../../src/core/bytes.js';
import { createDeferred, createSignal, withDeadline } from '../../src/core/deadline.js';
import { DisposalStack } from '../../src/core/disposable.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import type { Logger } from '../../src/core/types.js';
import { FakeClock, flushMicrotasks } from '../harness/fake-clock.js';
import { recordingLogger } from '../harness/recording-logger.js';

describe('assertNever', () => {
  it('reports an unhandled union member', () => {
    // Reached only when a union gains a member and a switch does not. The compiler catches it
    // first; this is what happens when the value arrives from outside the type system.
    expect(() => assertNever('surprise' as never, 'status')).toThrow(/Unhandled status/);
  });
});

describe('DisposalStack', () => {
  it('disposes in reverse acquisition order', () => {
    const stack = new DisposalStack();
    const order: number[] = [];

    stack.add(() => order.push(1));
    stack.add(() => order.push(2));
    stack.add(() => order.push(3));
    stack.disposeAll();

    // Last acquired, first released: a reader taken after a port must be released before it.
    expect(order).toEqual([3, 2, 1]);
  });

  it('is idempotent', () => {
    const stack = new DisposalStack();
    const disposer = vi.fn();

    stack.add(disposer);
    stack.disposeAll();
    stack.disposeAll();

    expect(disposer).toHaveBeenCalledOnce();
    expect(stack.isDisposed).toBe(true);
  });

  it('runs every disposer even when one throws', () => {
    const stack = new DisposalStack();
    const after = vi.fn();

    stack.add(after);
    stack.add(() => {
      throw new Error('a disposer misbehaved');
    });
    const failures = stack.disposeAll();

    // Teardown runs on paths where something has already gone wrong; one failing disposer
    // must not strand every resource below it.
    expect(after).toHaveBeenCalledOnce();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('a disposer misbehaved');
  });

  it('disposes immediately anything registered after teardown', () => {
    const stack = new DisposalStack();
    stack.disposeAll();
    const late = vi.fn();

    stack.add(late);

    // Closes the race where a resource is acquired asynchronously and arrives after teardown
    // has begun - which would otherwise leak it with nothing left to release it.
    expect(late).toHaveBeenCalledOnce();
  });

  it('reports the failure of a disposer registered after teardown on the next call', () => {
    const stack = new DisposalStack();
    stack.disposeAll();

    stack.add(() => {
      throw new Error('late');
    });

    expect(stack.disposeAll()).toEqual(['Error: late']);
    expect(stack.disposeAll()).toEqual([]);
  });
});

describe('createDeferred', () => {
  it('resolves from outside', async () => {
    const deferred = createDeferred<number>();

    deferred.resolve(42);

    await expect(deferred.promise).resolves.toBe(42);
  });

  it('ignores a second settlement', async () => {
    const deferred = createDeferred<number>();

    deferred.resolve(1);
    deferred.resolve(2);
    deferred.reject(new Error('too late'));

    await expect(deferred.promise).resolves.toBe(1);
  });

  it('creates a signal that resolves with no argument', async () => {
    const signal = createSignal();

    signal.resolve();

    await expect(signal.promise).resolves.toBeUndefined();
  });

  it('rejects a signal with the given reason', async () => {
    const signal = createSignal();

    signal.reject(new SerialBrokerError(SerialBrokerErrorCode.UNKNOWN, 'x'));

    await expect(signal.promise).rejects.toThrow(SerialBrokerError);
  });
});

describe('withDeadline', () => {
  it('passes through a result that arrives in time', async () => {
    const clock = new FakeClock();

    const result = await withDeadline(Promise.resolve('done'), clock, {
      timeoutMs: 1_000,
      code: SerialBrokerErrorCode.OPEN_TIMEOUT,
      message: 'too slow',
    });

    expect(result).toBe('done');
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('rejects with the configured code when the deadline passes', async () => {
    const clock = new FakeClock();
    const never = new Promise<never>(() => undefined);

    const settled = withDeadline(never, clock, {
      timeoutMs: 1_000,
      code: SerialBrokerErrorCode.OPEN_TIMEOUT,
      message: 'the device did not answer',
      configName: 'Reader',
    }).catch((error: unknown) => error as SerialBrokerError);
    await clock.advance(1_000);

    const error = await settled;
    expect(error.code).toBe(SerialBrokerErrorCode.OPEN_TIMEOUT);
    expect(error.configName).toBe('Reader');
    expect(error.context.timeoutMs).toBe(1_000);
  });

  it('clears its timer when the operation rejects first', async () => {
    const clock = new FakeClock();

    await expect(
      withDeadline(Promise.reject(new Error('boom')), clock, {
        timeoutMs: 1_000,
        code: SerialBrokerErrorCode.OPEN_TIMEOUT,
        message: 'x',
      }),
    ).rejects.toThrow('boom');

    expect(clock.pendingTimerCount).toBe(0);
  });

  it('leaves no unhandled rejection behind when the operation fails after its deadline', async () => {
    const clock = new FakeClock();
    let failLate!: (reason: unknown) => void;
    const operation = new Promise<never>((_, reject) => {
      failLate = reject;
    });

    const settled = withDeadline(operation, clock, {
      timeoutMs: 10,
      code: SerialBrokerErrorCode.OPEN_TIMEOUT,
      message: 'x',
    }).catch((error: unknown) => error as SerialBrokerError);
    await clock.advance(10);
    const error = await settled;
    failLate(new Error('late'));
    await flushMicrotasks();

    // `port.open()` has no abort signal and may give up long after the deadline. Its rejection
    // would surface in the application's console as an error it can do nothing about - and the
    // test runner fails the run on an unhandled rejection.
    expect(error.code).toBe(SerialBrokerErrorCode.OPEN_TIMEOUT);
  });
});

describe('ScopedLogger', () => {
  it('attaches its scope to every record', () => {
    const { logger, records } = recordingLogger();

    new ScopedLogger(logger, { clientId: 'c-1' }).info('opened', { configName: 'Reader' });

    // Records from six tabs in one console are otherwise guesswork.
    expect(records[0]?.[2]).toEqual({ clientId: 'c-1', configName: 'Reader' });
  });

  it('extends a scope without touching its parent', () => {
    const { logger, records } = recordingLogger();
    const parent = new ScopedLogger(logger, { clientId: 'c-1' });

    parent.child({ configName: 'Reader' }).warn('slow');
    parent.debug('still just me');

    expect(records[0]?.[2]).toMatchObject({ clientId: 'c-1', configName: 'Reader' });
    expect(records[1]?.[2]).toEqual({ clientId: 'c-1' });
  });

  it('records every level', () => {
    const { logger, records } = recordingLogger();
    const scoped = new ScopedLogger(logger, {});

    scoped.debug('d');
    scoped.info('i');
    scoped.warn('w');
    scoped.error('e');

    expect(records.map((record) => record[0])).toEqual(['debug', 'info', 'warn', 'error']);
  });

  it('survives an application logger that throws', () => {
    const hostile: Logger = {
      log: () => {
        throw new Error('my logger is broken');
      },
    };

    // Failing a write because logging failed would be absurd.
    expect(() => {
      new ScopedLogger(hostile, {}).info('x');
    }).not.toThrow();
  });

  it('discards everything by default', () => {
    // A library that writes to the host console uninvited is a bad citizen.
    expect(() => {
      NOOP_LOGGER.log('error', 'x', {});
    }).not.toThrow();
  });
});

describe('copyBytes', () => {
  it.each([
    ['null', null, 'null', undefined],
    ['a number', 42, 'number', 42],
    ['an array of numbers', [1, 2], 'object', undefined],
  ])('describes %s like any other invalid argument', (_label, value, actualType, actualValue) => {
    // docs/site/errors.md promises these fields for every INVALID_ARGUMENT.
    expect(() => copyBytes(value as unknown as BufferSource)).toThrow(
      expect.objectContaining({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
        context: {
          argumentName: 'data',
          expected: 'a string, an ArrayBuffer or an ArrayBufferView',
          actualType,
          actualValue,
        },
      }),
    );
  });

  it('copies exactly the bytes a view spans, never sharing its buffer', () => {
    const buffer = new Uint8Array([1, 2, 3, 4, 5, 6]).buffer;
    const view = new DataView(buffer, 2, 3);

    const copy = copyBytes(view);
    new Uint8Array(buffer).fill(0);

    expect([...copy]).toEqual([3, 4, 5]);
  });
});

describe('toHex', () => {
  it('formats bytes for a debug record', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe('00 0F FF');
  });

  it('truncates a long payload and says how long it was', () => {
    const hex = toHex(new Uint8Array(100));

    expect(hex).toContain('...');
    expect(hex).toContain('100 bytes');
  });
});

describe('disposal', () => {
  it('reports a failure of a disposer registered while disposing, in the same call', () => {
    const stack = new DisposalStack();
    stack.add(() => {
      stack.add(() => {
        throw new Error('late');
      });
    });

    expect(stack.disposeAll()).toEqual(['Error: late']);
  });
});

describe('copying payload bytes', () => {
  it('accepts an ArrayBuffer from another realm', async () => {
    const { runInNewContext } = await import('node:vm');
    const foreign = runInNewContext('new Uint8Array([1, 2, 3]).buffer') as ArrayBuffer;

    expect([...copyBytes(foreign)]).toEqual([1, 2, 3]);
  });

  it('copies a view of shared memory into memory of its own', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([1, 2, 3, 4]);

    const copy = copyBytes(shared.subarray(1, 3) as unknown as BufferSource);

    expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...copy]).toEqual([2, 3]);
  });

  it('reports a view of a transferred buffer as a serial-broker error', () => {
    const buffer = new ArrayBuffer(4);
    const view = new Uint8Array(buffer, 1, 2);
    structuredClone(buffer, { transfer: [buffer] });

    expect(() => copyBytes(view)).toThrow(
      expect.objectContaining({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
        context: expect.objectContaining({ detached: true }) as unknown,
      }),
    );
  });
});
