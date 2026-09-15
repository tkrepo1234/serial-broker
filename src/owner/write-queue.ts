import { createDeferred, createSignal, type Signal } from '../core/deadline.js';

/** A queued job that can still be taken out of the queue before it begins. */
export interface WithdrawableJob<T> {
  /** Settles with the job's outcome, or rejects with the reason it was withdrawn. */
  readonly promise: Promise<T>;
  /**
   * Takes the job out of the queue, if it has not begun, and rejects its promise with `reason`.
   *
   * @returns `false` for a job that has begun or ended: it runs to its own end.
   */
  withdraw(reason: unknown): boolean;
}

/** One job in the queue. */
interface Entry {
  /** Runs the job and settles its promise. Never rejects. */
  readonly start: () => Promise<void>;
  /** Rejects the job's promise without running it. */
  readonly abandon: (reason: unknown) => void;
  /** Resolves once the job has ended or was withdrawn: what {@link WriteQueue.drain} waits for. */
  readonly finished: Signal;
}

/**
 * Runs asynchronous jobs strictly one after another.
 *
 * Every write to the device goes through here. Without it, two `send()` calls arriving in the
 * same turn would both reach `writer.write()` and the device would receive two commands
 * interleaved byte by byte - which for a command-oriented device means neither of them.
 *
 * A job that fails does not stop the queue: the failure belongs to the caller that submitted
 * it, and the writes queued behind it are unrelated work. See ADR-0013.
 *
 * A job waiting behind a slow one can be withdrawn. The queue is a list rather than a chain of
 * promises for that reason: a withdrawn job leaves it at once, and with it everything the job holds -
 * a write's payload - instead of staying reachable until the jobs in front of it have ended.
 */
export class WriteQueue {
  /** Jobs that have not begun, oldest first: a `Map` iterates in insertion order. */
  readonly #waiting = new Map<number, Entry>();
  #running: Entry | undefined;
  #nextKey = 0;
  #isStartScheduled = false;

  /** Number of jobs queued but not yet finished, including the one running. */
  get depth(): number {
    return this.#waiting.size + (this.#running === undefined ? 0 : 1);
  }

  /** Queues `job` behind everything already queued, so that it can be withdrawn until it begins. */
  enqueueWithdrawable<T>(job: () => Promise<T>): WithdrawableJob<T> {
    const outcome = createDeferred<T>();
    const entry: Entry = {
      start: async () => {
        try {
          outcome.resolve(await job());
        } catch (error) {
          outcome.reject(error);
        }
      },
      abandon: (reason) => {
        outcome.reject(reason);
      },
      finished: createSignal(),
    };

    const key = this.#nextKey;
    this.#nextKey += 1;
    this.#waiting.set(key, entry);
    this.#scheduleStart();

    return {
      promise: outcome.promise,
      withdraw: (reason) => {
        if (!this.#waiting.delete(key)) {
          return false;
        }
        entry.abandon(reason);
        entry.finished.resolve();
        return true;
      },
    };
  }

  /**
   * Resolves once every job queued so far has finished, successfully or not, or was withdrawn.
   *
   * A job queued after the call is not waited for. Used when closing a port in an orderly way,
   * where jobs queued after the close began find the port gone and finish at once.
   */
  async drain(): Promise<void> {
    const pending = [...this.#waiting.values()];
    if (this.#running !== undefined) {
      pending.push(this.#running);
    }
    await Promise.all(pending.map((entry) => entry.finished.promise));
  }

  /** Starts the next job in a microtask, as a job queued behind a settled promise would start. */
  #scheduleStart(): void {
    if (this.#running !== undefined || this.#isStartScheduled) {
      return;
    }
    this.#isStartScheduled = true;
    void Promise.resolve().then(() => {
      this.#isStartScheduled = false;
      this.#startNext();
    });
  }

  #startNext(): void {
    if (this.#running !== undefined) {
      return;
    }
    const next = this.#waiting.entries().next();
    if (next.done === true) {
      return;
    }
    const [key, entry] = next.value;
    this.#waiting.delete(key);
    this.#running = entry;
    void entry.start().then(() => {
      this.#running = undefined;
      entry.finished.resolve();
      this.#startNext();
    });
  }
}
