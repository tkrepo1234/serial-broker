import type { Clock, TimerHandle } from '../core/clock.js';
import type { TermId } from '../protocol/messages.js';

/**
 * How long a term that was succeeded without saying goodbye is waited for (ADR-0026).
 *
 * A holder that let go cleanly sends `owner-released` as its last message, and that ends its term
 * at once. One that crashed says nothing more, but what it sent before crashing may still be on its
 * way - including that a write began, or how it ended. Messages cross between tabs within
 * milliseconds; a second covers a busy main thread as well, and stays below the default
 * `writeTimeoutMs`.
 */
export const FORMER_OWNER_GRACE_MS = 1_000;

/** How many ended and succeeded terms are remembered, so their late messages are recognised. */
export const MAX_REMEMBERED_TERMS = 64;

/** What the tracker needs. */
export interface OwnerTermsHost {
  readonly clock: Clock;
  /**
   * A term ended: its `owner-released` arrived, this tab's own term stopped, or it was succeeded
   * and {@link FORMER_OWNER_GRACE_MS} passed without word from it.
   */
  readonly onEnded: (term: TermId) => void;
}

/**
 * What one tab knows about the terms of holding a configuration's port (ADR-0026).
 *
 * Messages from the tab that held the port and from the tab that holds it now have no order between
 * them, so hearing a new claim proves only that the former holder let go of the lock - not that its
 * last words have arrived. A term is therefore **ended** only when that is provable: its
 * `owner-released`, the last message it sends, has arrived. A term that was **succeeded** without
 * one - its holder crashed, or its goodbye is still on the way - is given a grace period, restarted
 * by every word from it, and taken for ended when that passes.
 */
export class OwnerTerms {
  #current: TermId | undefined;
  readonly #ended = new Set<TermId>();
  readonly #succeeded = new Set<TermId>();
  readonly #graceTimers = new Map<TermId, TimerHandle>();

  constructor(private readonly host: OwnerTermsHost) {}

  /** The term of the tab holding the port, as far as this tab has heard; `undefined` if none. */
  get current(): TermId | undefined {
    return this.#current;
  }

  /** `true` once nothing more can come from `term`. */
  isEnded(term: TermId): boolean {
    return this.#ended.has(term);
  }

  /**
   * A claim or a status of `term` arrived.
   *
   * @returns `false` for a term that has ended or been succeeded: its message is stale, and nothing
   *   may be taken from it.
   */
  observe(term: TermId): boolean {
    if (term === this.#current) {
      return true;
    }
    if (this.#ended.has(term) || this.#succeeded.has(term)) {
      return false;
    }

    const previous = this.#current;
    this.#current = term;
    if (previous !== undefined) {
      remember(this.#succeeded, previous);
      this.#startGrace(previous);
    }
    return true;
  }

  /** Something arrived from `term`: a term still being waited for is waited for afresh. */
  heard(term: TermId): void {
    if (this.#graceTimers.has(term)) {
      this.#startGrace(term);
    }
  }

  /** `term` provably ended. */
  end(term: TermId): void {
    if (this.#ended.has(term)) {
      return;
    }
    remember(this.#ended, term);
    this.#stopGrace(term);
    if (this.#current === term) {
      this.#current = undefined;
    }
    this.host.onEnded(term);
  }

  /** Stops every timer. Used when the configuration goes away. */
  dispose(): void {
    for (const term of [...this.#graceTimers.keys()]) {
      this.#stopGrace(term);
    }
  }

  #startGrace(term: TermId): void {
    this.#stopGrace(term);
    this.#graceTimers.set(
      term,
      this.host.clock.setTimer(() => {
        this.#graceTimers.delete(term);
        this.end(term);
      }, FORMER_OWNER_GRACE_MS),
    );
  }

  #stopGrace(term: TermId): void {
    const timer = this.#graceTimers.get(term);
    if (timer !== undefined) {
      this.host.clock.clearTimer(timer);
      this.#graceTimers.delete(term);
    }
  }
}

/** Adds to a set that forgets its oldest entries beyond {@link MAX_REMEMBERED_TERMS}. */
function remember(set: Set<TermId>, term: TermId): void {
  set.add(term);
  if (set.size > MAX_REMEMBERED_TERMS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) {
      set.delete(oldest);
    }
  }
}
