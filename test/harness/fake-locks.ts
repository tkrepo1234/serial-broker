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
 * the specification the library depends on:
 *
 * - exclusive mode, granted to one holder at a time;
 * - shared mode, granted to any number of holders while no exclusive lock is held (ADR-0020);
 * - one FIFO queue per name for both modes, so the longest-waiting context succeeds a departing
 *   holder, and a shared request queued behind an exclusive one waits for it;
 * - `ifAvailable`, which answers `null` unless the request could be granted at once;
 * - `AbortSignal`, which rejects a *queued* request and never revokes a granted one;
 * - release on context death, which is the behaviour the entire failover design rests on and
 *   which no real browser lets a test trigger deliberately.
 */
export class FakeLockManager {
  readonly #held = new Map<string, HeldLock[]>();
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
      held: [...this.#held].flatMap(([name, holders]) =>
        holders.map((lock) => ({ name, mode: lock.mode, clientId: lock.contextId })),
      ),
      pending: [...this.#queues].flatMap(([name, queue]) =>
        queue.map((request) => ({ name, mode: request.mode, clientId: request.contextId })),
      ),
    };
  }

  /** The context currently holding `name` (the first, for a shared lock), or `undefined`. */
  holderOf(name: string): string | undefined {
    return this.#held.get(name)?.[0]?.contextId;
  }

  /** Every context currently holding `name`. Assertions only. */
  holdersOf(name: string): string[] {
    return (this.#held.get(name) ?? []).map((lock) => lock.contextId);
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
    for (const [name, queue] of this.#queues) {
      const remaining = queue.filter((request) => request.contextId !== contextId);
      this.#queues.set(name, remaining);
    }

    for (const [name, holders] of [...this.#held]) {
      const remaining = holders.filter((lock) => lock.contextId !== contextId);
      if (remaining.length !== holders.length) {
        this.#setHeld(name, remaining);
        this.#grantWaiting(name);
      }
    }
  }

  async #request<T>(
    contextId: string,
    name: string,
    options: LockRequestOptions,
    callback: (lock: LockLike | null) => Promise<T>,
  ): Promise<T> {
    const mode = options.mode ?? 'exclusive';

    if (options.signal?.aborted === true) {
      throw abortError();
    }

    let holder: HeldLock | undefined;
    const granted = new Promise<LockLike | null>((resolve, reject) => {
      const isQueueEmpty = (this.#queues.get(name) ?? []).length === 0;
      if (isQueueEmpty && this.#isCompatible(name, mode)) {
        holder = this.#hold(name, contextId, mode);
        resolve({ name, mode });
        return;
      }

      if (options.ifAvailable === true) {
        resolve(null);
        return;
      }

      const queue = this.#queues.get(name) ?? [];
      const request: QueuedRequest = {
        contextId,
        mode,
        grant: (lock) => {
          holder = this.#held.get(name)?.at(-1);
          resolve(lock);
        },
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
            // A shared request behind an aborted exclusive one may be grantable now.
            this.#grantWaiting(name);
          }
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
      }

      queue.push(request);
      this.#queues.set(name, queue);
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
      const holders = this.#held.get(name) ?? [];
      if (holder !== undefined && holders.includes(holder)) {
        this.#setHeld(
          name,
          holders.filter((entry) => entry !== holder),
        );
        this.#grantWaiting(name);
      }
    }
  }

  /** Whether a lock of `mode` can be held alongside what is held of `name` now. */
  #isCompatible(name: string, mode: 'exclusive' | 'shared'): boolean {
    const holders = this.#held.get(name) ?? [];
    return mode === 'exclusive'
      ? holders.length === 0
      : holders.every((lock) => lock.mode === 'shared');
  }

  #hold(name: string, contextId: string, mode: 'exclusive' | 'shared'): HeldLock {
    const lock: HeldLock = { contextId, mode };
    this.#setHeld(name, [...(this.#held.get(name) ?? []), lock]);
    return lock;
  }

  #setHeld(name: string, holders: HeldLock[]): void {
    if (holders.length === 0) {
      this.#held.delete(name);
    } else {
      this.#held.set(name, holders);
    }
  }

  /** Grants queued requests from the front, for as long as the first one is compatible. */
  #grantWaiting(name: string): void {
    const queue = this.#queues.get(name);
    while (queue !== undefined && queue.length > 0) {
      const next = queue[0];
      if (next === undefined || !this.#isCompatible(name, next.mode)) {
        return;
      }
      queue.shift();
      this.#hold(name, next.contextId, next.mode);
      next.grant({ name, mode: next.mode });
    }
  }
}

function abortError(): Error {
  return Object.assign(new Error('The lock request was aborted'), { name: 'AbortError' });
}
