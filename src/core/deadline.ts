import type { Clock } from './clock.js';
import type { SerialBrokerErrorCode } from './error-codes.js';
import { SerialBrokerError } from './errors.js';

/** A promise with externally accessible `resolve` and `reject`. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
}

/**
 * Creates a {@link Deferred}.
 *
 * Needed wherever a promise is settled by an event arriving later from another context - a
 * write acknowledged by the owning tab, a lock being granted - which is most of this library.
 * Only the first `resolve` or `reject` counts; later ones do nothing.
 */
export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  let isSettled = false;

  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      res(value);
    };
    reject = (reason) => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      // A Deferred forwards whatever its owner rejects with. Every caller in this library
      // passes a SerialBrokerError, but the primitive itself must not assume that.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      rej(reason);
    };
  });

  return {
    promise,
    resolve: (value) => {
      resolve(value);
    },
    reject: (reason) => {
      reject(reason);
    },
  };
}

/**
 * A promise that carries no value, settled from outside.
 *
 * Most of this library's deferreds are signals rather than value carriers: a lock released, a
 * write acknowledged, a teardown finished. Giving that case its own type says so, and keeps
 * `resolve()` callable with no argument.
 */
export interface Signal {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

/** Creates a {@link Signal}. */
export function createSignal(): Signal {
  const deferred = createDeferred<undefined>();

  return {
    promise: deferred.promise,
    resolve: () => {
      deferred.resolve(undefined);
    },
    reject: (reason) => {
      deferred.reject(reason);
    },
  };
}

/** Options for {@link withDeadline}. */
export interface DeadlineOptions {
  /** Milliseconds before the deadline expires. */
  readonly timeoutMs: number;
  /** Error code used when it does. */
  readonly code: SerialBrokerErrorCode;
  /** Message used when it does. */
  readonly message: string;
  /** Configuration the operation belongs to. */
  readonly configName?: string | undefined;
  /** Extra structured detail for the timeout error. */
  readonly context?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * Rejects if `operation` has not settled within the deadline.
 *
 * Every call into Web Serial that has to finish goes through this: listing the ports, `open()`,
 * `close()`, each `write()`, and ending the streams. A yanked device can leave any of them pending
 * forever, and an await that never returns would wedge the state machine with no way out. See
 * docs/guidelines/defensive-programming.md.
 *
 * `read()` is the exception, because waiting for the device to send something is what it is for.
 * A read left pending ends when its reader is cancelled, and that cancellation is bounded.
 *
 * @remarks
 * The operation itself is not cancelled - `port.open()` has no abort signal - and may settle
 * later. A late rejection is not reported as unhandled, because the race below has already
 * attached a handler to it; whatever a late success produced is the caller's to clean up.
 *
 * The timer is always cleared, including on the failure path, so a fast rejection does not
 * leave a pending timer behind.
 */
export async function withDeadline<T>(
  operation: Promise<T>,
  clock: Clock,
  options: DeadlineOptions,
): Promise<T> {
  const timeout = createDeferred<never>();

  const handle = clock.setTimer(() => {
    timeout.reject(
      new SerialBrokerError(options.code, options.message, {
        configName: options.configName,
        context: { ...options.context, timeoutMs: options.timeoutMs },
        timestamp: clock.now(),
      }),
    );
  }, options.timeoutMs);

  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clock.clearTimer(handle);
  }
}
