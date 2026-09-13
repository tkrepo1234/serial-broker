import { describeUnknown } from './errors.js';

/**
 * Collects disposers and releases them in reverse acquisition order.
 *
 * Every resource in this library - timers, event listeners, stream readers, worker ports,
 * lock requests - is registered here by its owner. The three properties this guarantees are
 * the ones that matter when a context is being torn down while things are still in flight:
 *
 * - **Idempotent:** disposing twice is legal and does nothing the second time.
 * - **Exception-safe:** a throwing disposer never prevents the remaining ones from running.
 * - **Ordered:** last acquired, first released.
 *
 * There is deliberately no `dispose()` that returns nothing: teardown hands back what failed, so
 * that a caller has to decide what to do with it rather than lose it (docs/guidelines/error-handling.md).
 *
 * See docs/guidelines/defensive-programming.md.
 */
export class DisposalStack {
  readonly #disposers: (() => void)[] = [];
  /** Failures of disposers that {@link add} ran at once, not yet returned by {@link disposeAll}. */
  readonly #failures: unknown[] = [];
  #isDisposed = false;

  /** `true` once {@link disposeAll} has run. */
  get isDisposed(): boolean {
    return this.#isDisposed;
  }

  /**
   * Registers a disposer.
   *
   * If the stack has already been disposed, the disposer runs immediately - this closes the
   * race where a resource is acquired asynchronously and its acquisition settles after
   * teardown has begun, which would otherwise leak it silently.
   */
  add(disposer: () => void): void {
    if (this.#isDisposed) {
      runSafely(disposer, this.#failures);
      return;
    }
    this.#disposers.push(disposer);
  }

  /**
   * Runs every disposer in reverse order.
   *
   * Never throws. Failures are collected and returned so the caller can report them through
   * the error channel rather than losing them. Once disposed, each further call returns the
   * failures of disposers registered since - which {@link add} ran at once.
   *
   * @returns Descriptions of every disposer that threw; empty when all succeeded.
   */
  disposeAll(): readonly string[] {
    if (this.#isDisposed) {
      return this.#failures.splice(0).map(describeUnknown);
    }
    this.#isDisposed = true;

    const failures: unknown[] = [];
    while (this.#disposers.length > 0) {
      // `pop()` cannot return undefined while length > 0, but `noUncheckedIndexedAccess`
      // cannot know that, and an explicit check is cheaper than an assertion here.
      const disposer = this.#disposers.pop();
      if (disposer !== undefined) {
        runSafely(disposer, failures);
      }
    }

    // A disposer that registers another one while this runs has it run at once, and its failure
    // lands in `#failures`: collected here, so it is reported by this call rather than a later one.
    failures.push(...this.#failures.splice(0));
    return failures.map(describeUnknown);
  }
}

function runSafely(disposer: () => void, failures: unknown[]): void {
  try {
    disposer();
  } catch (error) {
    failures.push(error);
  }
}
