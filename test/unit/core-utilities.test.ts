import { describe, expect, it, vi } from 'vitest';

import { assertNever } from '../../src/core/assert.js';
import { toHex } from '../../src/core/bytes.js';
import {
  createDeferred,
  createSignal,
  ignoreRejection,
  withDeadline,
} from '../../src/core/deadline.js';
import { DisposalStack } from '../../src/core/disposable.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerError } from '../../src/core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import type { LogFields, Logger, LogLevel } from '../../src/core/types.js';
import { WriteQueue } from '../../src/owner/write-queue.js';
import { FakeClock } from '../harness/fake-clock.js';

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
    stack.dispose();

    // Last acquired, first released: a reader taken after a port must be released before it.
    expect(order).toEqual([3, 2, 1]);
  });

  it('is idempotent', () => {
    const stack = new DisposalStack();
    const disposer = vi.fn();

    stack.add(disposer);
    stack.dispose();
    stack.dispose();

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
    stack.dispose();
    const late = vi.fn();

    stack.add(late);

    // Closes the race where a resource is acquired asynchronously and arrives after teardown
    // has begun - which would otherwise leak it with nothing left to release it.
    expect(late).toHaveBeenCalledOnce();
  });

  it('accepts a Disposable as well as a function', () => {
    const stack = new DisposalStack();
    const disposable = { dispose: vi.fn() };

    stack.addDisposable(disposable);
    stack.dispose();

    expect(disposable.dispose).toHaveBeenCalledOnce();
  });
});

describe('createDeferred', () => {
  it('resolves from outside', async () => {
    const deferred = createDeferred<number>();

    deferred.resolve(42);

    await expect(deferred.promise).resolves.toBe(42);
    expect(deferred.isSettled).toBe(true);
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
    expect(error.context['timeoutMs']).toBe(1_000);
  });

  it('runs the timeout hook so an abandoned operation can be cleaned up', async () => {
    const clock = new FakeClock();
    const onTimeout = vi.fn();

    const settled = withDeadline(new Promise<never>(() => undefined), clock, {
      timeoutMs: 10,
      code: SerialBrokerErrorCode.OPEN_TIMEOUT,
      message: 'x',
      onTimeout,
    }).catch(() => undefined);
    await clock.advance(10);
    await settled;

    // `port.open()` has no abort signal, so it may still settle later; the hook is what
    // discards whatever it produces.
    expect(onTimeout).toHaveBeenCalledOnce();
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

  it('silences a rejection from an abandoned operation', async () => {
    // An operation abandoned after its deadline still rejects later. Without this, it would
    // surface in the application's console as an error it can do nothing about.
    expect(() => {
      ignoreRejection(Promise.reject(new Error('late')));
    }).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
});

describe('WriteQueue', () => {
  it('runs jobs one after another, never overlapping', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];

    const first = queue.enqueue(async () => {
      events.push('first:start');
      await Promise.resolve();
      events.push('first:end');
    });
    const second = queue.enqueue(async () => {
      events.push('second:start');
      await Promise.resolve();
      events.push('second:end');
    });
    await Promise.all([first, second]);

    // Interleaving here means two commands reaching the device byte by byte, which for a
    // command-oriented device means neither of them.
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps running after a job fails', async () => {
    const queue = new WriteQueue();
    const after = vi.fn();

    const failing = queue.enqueue(async () => {
      await Promise.resolve();
      throw new Error('the device refused');
    });
    const next = queue.enqueue(async () => {
      after();
      await Promise.resolve();
    });

    await expect(failing).rejects.toThrow('the device refused');
    await next;
    expect(after).toHaveBeenCalledOnce();
  });

  it('reports a failure only to the caller that submitted it', async () => {
    const queue = new WriteQueue();

    const failing = queue.enqueue(() => Promise.reject(new Error('mine')));
    const other = queue.enqueue(() => Promise.resolve('ok'));

    await expect(failing).rejects.toThrow('mine');
    await expect(other).resolves.toBe('ok');
  });

  it('tracks how much work is outstanding', async () => {
    const queue = new WriteQueue();

    const job = queue.enqueue(async () => {
      await Promise.resolve();
    });
    expect(queue.depth).toBe(1);

    await job;
    await queue.drain();
    expect(queue.depth).toBe(0);
  });
});

describe('ScopedLogger', () => {
  function recordingLogger(): { logger: Logger; records: [LogLevel, string, LogFields][] } {
    const records: [LogLevel, string, LogFields][] = [];
    return {
      logger: { log: (level, message, fields) => records.push([level, message, fields]) },
      records,
    };
  }

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

describe('toHex', () => {
  it('formats bytes for a debug record', () => {
    expect(toHex(new Uint8Array([0x00, 0x0f, 0xff]))).toBe('00 0F FF');
  });

  it('truncates a long payload and says how long it was', () => {
    const hex = toHex(new Uint8Array(100), 4);

    expect(hex).toContain('...');
    expect(hex).toContain('100 bytes');
  });
});
