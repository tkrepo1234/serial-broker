import type {
  LockLike,
  LockManagerLike,
  LockRequestOptions,
  LockSnapshotLike,
} from '../../src/environment/environment.js';

interface QueuedRequest {
  readonly contextId: string;
  readonly mode: 'exclusive' | 'shared';
  readonly grant: (lock: LockLike | null) => void;
  readonly failed: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: (() => void) | undefined;
}

interface HeldLock {
  readonly contextId: string;
  readonly mode: 'exclusive' | 'shared';
}

/**
 * The Web Locks API, shared by every simulated context in a test.
 *
 * This fake carries more weight than any other in the suite: ownership *is* the lock
 * (ADR-0005), so if this lies, every failover test lies with it. It implements the parts of
 * the specification the library depends on, and refuses shared mode, which the library does not
 * use and this fake does not model:
 *
 * - exclusive mode, granted to one holder at a time;
 * - FIFO queueing, so the longest-waiting context succeeds a departing holder;
 * - `AbortSignal`, which rejects a *queued* request and never revokes a granted one;
 * - release on context death, which is the behaviour the entire failover design rests on and
 *   which no real browser lets a test trigger deliberately.
 */
export class FakeLockManager {
  readonly #held = new Map<string, HeldLock>();
  readonly #queues = new Map<string, QueuedRequest[]>();

  /** A view onto this manager scoped to one simulated context. */
  forContext(contextId: string): LockManagerLike {
    return {
      request: async <T>(
        name: string,
        options: LockRequestOptions,
        callback: (lock: LockLike | null) => Promise<T>,
      ): Promise<T> => await this.#request(contextId, name, options, callback),
      query: async (): Promise<LockSnapshotLike> => this.#snapshot(),
    };
  }

  /** What `LockManager.query()` would report: holders and queued requests, per lock. */
  #snapshot(): LockSnapshotLike {
    return {
      held: [...this.#held].map(([name, lock]) => ({
        name,
        mode: lock.mode,
        clientId: lock.contextId,
      })),
      pending: [...this.#queues].flatMap(([name, queue]) =>
        queue.map((request) => ({ name, mode: request.mode, clientId: request.contextId })),
      ),
    };
  }

  /** The context currently holding `name`, or `undefined`. Assertions only. */
  holderOf(name: string): string | undefined {
    return this.#held.get(name)?.contextId;
  }

  /** How many contexts are queued behind the current holder of `name`. */
  queueLength(name: string): number {
    return this.#queues.get(name)?.length ?? 0;
  }

  /**
   * Simulates a context disappearing without any chance to clean up.
   *
   * A closed tab, a crashed renderer, an out-of-memory kill: the browser releases every lock
   * the context held, and the next queued request is granted. This is the single most
   * important behaviour in the harness, because it is the one a real browser cannot be asked
   * to perform on cue.
   */
  killContext(contextId: string): void {
    for (const [name, lock] of [...this.#held]) {
      if (lock.contextId === contextId) {
        this.#held.delete(name);
        this.#grantNext(name);
      }
    }

    for (const [name, queue] of this.#queues) {
      const remaining = queue.filter((request) => request.contextId !== contextId);
      this.#queues.set(name, remaining);
    }
  }

  async #request<T>(
    contextId: string,
    name: string,
    options: LockRequestOptions,
    callback: (lock: LockLike | null) => Promise<T>,
  ): Promise<T> {
    const mode = options.mode ?? 'exclusive';
    if (mode === 'shared') {
      // One holder per name is all this fake models. Granting a shared request as if it were
      // exclusive would pass a test that a browser fails, so it refuses instead.
      throw new Error('FakeLockManager does not model shared locks');
    }

    if (options.signal?.aborted === true) {
      throw abortError();
    }

    const granted = new Promise<LockLike | null>((resolve, reject) => {
      const enqueue = (): void => {
        const queue = this.#queues.get(name) ?? [];

        const request: QueuedRequest = {
          contextId,
          mode,
          grant: resolve,
          failed: reject,
          signal: options.signal,
          onAbort: undefined,
        };

        if (options.signal !== undefined) {
          const onAbort = (): void => {
            const current = this.#queues.get(name) ?? [];
            // Aborting only affects a request still queued: a granted lock is not revocable,
            // which is exactly why `steal` exists in the specification and why this library
            // never uses it.
            const index = current.indexOf(request);
            if (index >= 0) {
              current.splice(index, 1);
              reject(abortError());
            }
          };
          options.signal.addEventListener('abort', onAbort, { once: true });
        }

        queue.push(request);
        this.#queues.set(name, queue);
      };

      if (this.#held.has(name)) {
        if (options.ifAvailable === true) {
          resolve(null);
          return;
        }
        enqueue();
        return;
      }

      this.#hold(name, contextId, mode);
      resolve({ name, mode });
    });

    const lock = await granted;

    if (lock === null) {
      // `ifAvailable` with the lock taken: the callback runs with null and holds nothing.
      return await callback(null);
    }

    try {
      return await callback(lock);
    } finally {
      // The holder's callback has settled, so the lock is released - whether it returned or
      // threw. This mirrors the specification and is what makes a crashing owner release.
      if (this.#held.get(name)?.contextId === contextId) {
        this.#held.delete(name);
        this.#grantNext(name);
      }
    }
  }

  #hold(name: string, contextId: string, mode: 'exclusive' | 'shared'): void {
    this.#held.set(name, { contextId, mode });
  }

  #grantNext(name: string): void {
    const queue = this.#queues.get(name);
    const next = queue?.shift();
    if (next === undefined) {
      return;
    }

    this.#hold(name, next.contextId, next.mode);
    next.grant({ name, mode: next.mode });
  }
}

function abortError(): Error {
  return Object.assign(new Error('The lock request was aborted'), { name: 'AbortError' });
}
