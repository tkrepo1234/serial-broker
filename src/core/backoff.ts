/** Normalised backoff parameters. Every field is required; defaults are applied upstream. */
export interface BackoffSettings {
  readonly initialDelayMs: number;
  readonly factor: number;
  readonly maxDelayMs: number;
  readonly jitter: number;
  readonly maxAttempts: number;
}

/**
 * Computes the delay before a reconnect attempt.
 *
 * Exponential with full jitter (ADR-0010):
 *
 *     delay(n) = min(maxDelayMs, initialDelayMs * factor^(n-1)) * random(jitter..1)
 *
 * Attempt 0 is the immediate retry and is never delayed: a power-cycled device is usually
 * back within one event-loop turn, and waiting would turn a non-event into a visible outage.
 *
 * Jitter matters more than it looks. Several tabs, several configurations and several devices
 * behind one power switch all fail at the same instant; without jitter their retries stay
 * synchronised forever and arrive as bursts.
 *
 * @param attempt - Zero-based attempt number.
 * @param settings - Normalised backoff parameters.
 * @param random - Returns a value in `[0, 1)`. Injected for determinism (ADR-0014).
 * @returns Milliseconds to wait. Always finite and non-negative.
 */
export function computeBackoffDelayMs(
  attempt: number,
  settings: BackoffSettings,
  random: () => number,
): number {
  if (attempt <= 0) {
    return 0;
  }

  const exponential = settings.initialDelayMs * Math.pow(settings.factor, attempt - 1);
  const capped = Math.min(settings.maxDelayMs, exponential);

  // Full jitter: a uniform draw from [jitter*capped, capped]. With jitter = 0 this is the
  // classic "random between 0 and the cap"; with jitter = 1 it degenerates to no jitter.
  const floor = capped * settings.jitter;
  const jittered = floor + random() * (capped - floor);

  // `Math.pow` overflows to Infinity for large attempt counts before the cap is applied on
  // some paths; the cap below makes the result finite regardless of arithmetic order.
  return Math.min(settings.maxDelayMs, Math.max(0, Math.round(jittered)));
}

/**
 * Tracks reconnect attempts for one connection.
 *
 * The counter resets only after a connection has held for `stableAfterMs`, so a device that
 * accepts `open()` and immediately drops does not loop at the initial delay forever.
 */
export class BackoffState {
  #attempt = 0;
  #connectedAt: number | undefined;
  #losses = 0;

  /** Attempts made since the counter last started over. `maxAttempts` limits this. */
  get attempt(): number {
    return this.#attempt;
  }

  /**
   * Which delay the next retry waits: 0 for the first retry after the count started over, which
   * is immediate, then growing with every further loss.
   *
   * Counted from losses rather than from attempts, so that a connection that held long enough and
   * then dropped gets one immediate retry, exactly as a fresh start does, not two.
   */
  get retryIndex(): number {
    return Math.max(this.#losses - 1, 0);
  }

  /** `true` once the attempt about to be made would exceed `maxAttempts`. */
  hasExhausted(settings: BackoffSettings): boolean {
    return this.#attempt >= settings.maxAttempts;
  }

  /** Records that an attempt is being made. */
  recordAttempt(): void {
    this.#attempt += 1;
  }

  /** Records a successful connection at `now`, starting the stability window. */
  recordConnected(now: number): void {
    this.#connectedAt = now;
  }

  /**
   * Resets the attempt counter if the current connection has been stable long enough.
   *
   * Called when a connection is lost, with the time of the loss: the question is not "is it
   * stable now" but "was it stable for long enough before it broke".
   */
  recordDisconnected(now: number, stableAfterMs: number): void {
    const connectedAt = this.#connectedAt;
    if (connectedAt !== undefined && now - connectedAt >= stableAfterMs) {
      this.#attempt = 0;
      this.#losses = 0;
    }
    this.#losses += 1;
    this.#connectedAt = undefined;
  }

  /** Clears all state, as on an explicit reconnect request. */
  reset(): void {
    this.#attempt = 0;
    this.#losses = 0;
    this.#connectedAt = undefined;
  }
}
