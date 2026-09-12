import { describeUnknown } from './errors.js';

/** Something that can be released. Disposal must be idempotent and must never throw. */
export interface Disposable {
  dispose(): void;
}

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
 * See docs/guidelines/defensive-programming.md.
 */
export class DisposalStack implements Disposable {
  readonly #disposers: (() => void)[] = [];
  #isDisposed = false;

  /** `true` once {@link dispose} has run. */
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

  /** Registers a {@link Disposable}. */
  addDisposable(disposable: Disposable): void {
    this.add(() => {
      disposable.dispose();
    });
  }

  readonly #failures: unknown[] = [];

  /**
   * Runs every disposer in reverse order.
   *
   * Never throws. Failures are collected and returned so the caller can report them through
   * the error channel rather than losing them.
   *
   * @returns Descriptions of every disposer that threw; empty when all succeeded.
   */
  disposeAll(): readonly string[] {
    if (this.#isDisposed) {
      return [];
    }
    this.#isDisposed = true;

    const failures: unknown[] = [...this.#failures];
    this.#failures.length = 0;

    while (this.#disposers.length > 0) {
      // `pop()` cannot return undefined while length > 0, but `noUncheckedIndexedAccess`
      // cannot know that, and an explicit check is cheaper than an assertion here.
      const disposer = this.#disposers.pop();
      if (disposer !== undefined) {
        runSafely(disposer, failures);
      }
    }

    return failures.map(describeUnknown);
  }

  /** {@inheritDoc Disposable.dispose} */
  dispose(): void {
    this.disposeAll();
  }
}

function runSafely(disposer: () => void, failures: unknown[]): void {
  try {
    disposer();
  } catch (error) {
    failures.push(error);
  }
}
