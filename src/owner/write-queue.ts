/**
 * Runs asynchronous jobs strictly one after another.
 *
 * Every write to the device goes through here. Without it, two `send()` calls arriving in the
 * same turn would both reach `writer.write()` and the device would receive two commands
 * interleaved byte by byte - which for a command-oriented device means neither of them.
 *
 * A job that fails does not stop the queue: the failure belongs to the caller that submitted
 * it, and the writes queued behind it are unrelated work. See ADR-0013.
 */
export class WriteQueue {
  /** Settles when everything currently queued has finished, successfully or not. */
  #tail: Promise<unknown> = Promise.resolve();
  #depth = 0;

  /** Number of jobs queued but not yet finished, including the one running. */
  get depth(): number {
    return this.#depth;
  }

  /**
   * Queues `job` behind everything already queued.
   *
   * @returns A promise settling with `job`'s outcome - not with the queue's.
   */
  enqueue<T>(job: () => Promise<T>): Promise<T> {
    this.#depth += 1;

    // Both handlers run `job`: a preceding failure must not skip this job, and must not be
    // reported to this caller either.
    const result = this.#tail.then(job, job);

    this.#tail = result.then(
      () => {
        this.#depth -= 1;
      },
      () => {
        this.#depth -= 1;
      },
    );

    return result;
  }

  /** Resolves once the queue has drained. Used when closing a port in an orderly way. */
  async drain(): Promise<void> {
    await this.#tail;
  }
}
