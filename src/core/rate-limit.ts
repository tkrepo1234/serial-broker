import type { Clock } from './clock.js';
import type { ScopedLogger } from './logger.js';

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
 * What is dropped is logged **once** per limiter, as the size limits are (`protocol/limits.ts`):
 * a flood would otherwise become a flood of log records.
 *
 * The allowance is measured with `clock.now()`, which the system time can move. Set forward, a full
 * allowance comes back at once; set back, nothing comes back until the clock has caught up. Both are
 * harmless: the limit exists to bound work, not to measure time.
 */
export class RateLimiter {
  #tokens: number;
  #refilledAt: number;
  #hasLoggedDrop = false;

  /**
   * @param event - The documented event name of the record written when something is dropped.
   * @param what - What is being dropped, for that record's message.
   */
  constructor(
    private readonly limit: RateLimit,
    private readonly clock: Clock,
    private readonly logger: ScopedLogger,
    private readonly event: string,
    private readonly what: string,
  ) {
    this.#tokens = limit.burst;
    this.#refilledAt = clock.now();
  }

  /**
   * Takes one from the allowance.
   *
   * @returns `true` when there was one to take. `false` means the caller must drop what it was
   *   about to do; the first drop is logged.
   */
  take(): boolean {
    this.#refill();
    if (this.#tokens < 1) {
      this.#logOnce();
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
    const now = this.clock.now();
    // A clock set back would otherwise refill nothing until it has caught up with itself.
    const elapsedMs = Math.max(0, now - this.#refilledAt);
    this.#refilledAt = now;
    this.#tokens = Math.min(
      this.limit.burst,
      this.#tokens + (elapsedMs / 1_000) * this.limit.perSecond,
    );
  }

  #logOnce(): void {
    if (this.#hasLoggedDrop) {
      return;
    }
    this.#hasLoggedDrop = true;
    this.logger.warn(
      `dropped ${this.what} beyond the rate limit; further ones are dropped without a record`,
      {
        event: this.event,
        burst: this.limit.burst,
        perSecond: this.limit.perSecond,
      },
    );
  }
}
