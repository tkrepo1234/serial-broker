import type { Clock } from './clock.js';

/**
 * How often something coming from the bus may make a context work (ADR-0031).
 *
 * Validation and the limits of `protocol/limits.ts` bound what one message can cost. They do not
 * bound how many messages there are: any script of the origin can post as fast as it likes, and
 * every well-formed message was answered, reported or logged. A rate limit bounds the rest.
 */
export interface RateLimit {
  /** How many are allowed at once, before the allowance has to come back. */
  readonly burst: number;
  /** How many of the allowance come back per second. */
  readonly perSecond: number;
}

/**
 * A token bucket: `burst` allowed at once, refilled at `perSecond`.
 *
 * A burst is what legitimate use looks like - every tab of an origin asking for the status as it
 * joins, every tab answering one diagnostics request - and a flood is what a hostile or broken
 * sender looks like. A bucket lets the first through untouched and bounds the second.
 *
 * The allowance is measured on the monotonic clock (`clock.monotonicNow()`, ADR-0014), so setting
 * the system time neither refills it at once nor freezes it.
 */
export class RateLimiter {
  #tokens: number;
  #refilledAt: number;

  constructor(
    private readonly limit: RateLimit,
    private readonly clock: Clock,
  ) {
    this.#tokens = limit.burst;
    this.#refilledAt = clock.monotonicNow();
  }

  /**
   * Takes one from the allowance.
   *
   * @returns `true` when there was one to take. `false` means the caller must drop what it was
   *   about to do.
   */
  take(): boolean {
    this.#refill();
    if (this.#tokens < 1) {
      return false;
    }
    this.#tokens -= 1;
    return true;
  }

  /** Milliseconds until {@link take} would succeed again; `0` while one is allowed now. */
  delayUntilAllowed(): number {
    this.#refill();
    if (this.#tokens >= 1) {
      return 0;
    }
    return Math.ceil(((1 - this.#tokens) / this.limit.perSecond) * 1_000);
  }

  #refill(): void {
    const now = this.clock.monotonicNow();
    const elapsedMs = Math.max(0, now - this.#refilledAt);
    this.#refilledAt = now;
    this.#tokens = Math.min(
      this.limit.burst,
      this.#tokens + (elapsedMs / 1_000) * this.limit.perSecond,
    );
  }
}
