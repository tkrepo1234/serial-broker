import type { Clock } from './clock.js';
import { SerialBrokerErrorCode } from './error-codes.js';
import { SerialBrokerError } from './errors.js';

/** A promise with externally accessible `resolve` and `reject`. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason: unknown): void;
  /** `true` once `resolve` or `reject` has been called. */
  readonly isSettled: boolean;
}

/**
 * Creates a {@link Deferred}.
 *
 * Needed wherever a promise is settled by an event arriving later from another context - a
 * write acknowledged by the owning tab, a lock being granted - which is most of this library.
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
    get isSettled() {
      return isSettled;
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
  /**
   * Runs when the deadline expires, to release whatever the abandoned operation holds.
   *
   * The underlying promise is *not* cancellable - `port.open()` has no abort signal - so the
   * operation may still settle later. This hook exists to discard what it produces.
   */
  readonly onTimeout?: (() => void) | undefined;
}

/**
 * Rejects if `operation` has not settled within the deadline.
 *
 * Every call into Web Serial goes through this. A yanked device can leave `open()`,
 * `close()`, `read()` or `write()` pending forever, and an await that never returns would
 * wedge the state machine with no way out. See docs/guidelines/defensive-programming.md.
 *
 * @remarks
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
    options.onTimeout?.();
  }, options.timeoutMs);

  try {
    return await Promise.race([operation, timeout.promise]);
  } finally {
    clock.clearTimer(handle);
  }
}

/**
 * Prevents an unhandled rejection from a promise that is deliberately not awaited.
 *
 * Used where an operation is abandoned after its deadline expired: the original promise may
 * still reject much later, and an unhandled rejection would surface in the application's
 * console as a spurious error it can do nothing about.
 */
export function ignoreRejection(promise: Promise<unknown>): void {
  void promise.catch(() => {
    // Deliberately empty: the caller has already reported the timeout through the error
    // channel, and this rejection is the abandoned operation finally giving up.
  });
}
