import { describe, expect, it } from 'vitest';

import { RateLimiter, type RateLimit } from '../../src/core/rate-limit.js';
import { FakeClock } from '../harness/fake-clock.js';

const LIMIT: RateLimit = { burst: 4, perSecond: 2 };

function createLimiter(limit: RateLimit = LIMIT): { limiter: RateLimiter; clock: FakeClock } {
  const clock = new FakeClock();
  return { limiter: new RateLimiter(limit, clock), clock };
}

/**
 * The bound on how often the bus may make a context work (ADR-0031).
 *
 * A burst is what legitimate use looks like; a flood is what a broken or hostile sender looks
 * like.
 */
describe('RateLimiter', () => {
  it('allows a burst, and nothing beyond it until the allowance comes back', async () => {
    const { limiter, clock } = createLimiter();

    const allowed = [0, 1, 2, 3, 4].map(() => limiter.take());
    expect(allowed).toEqual([true, true, true, true, false]);

    await clock.advance(500);
    expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);
  });

  it('says how long it is until one is allowed again', async () => {
    const { limiter, clock } = createLimiter();

    expect(limiter.delayUntilAllowed()).toBe(0);
    for (let round = 0; round < LIMIT.burst; round += 1) {
      limiter.take();
    }

    expect(limiter.delayUntilAllowed()).toBe(500);
    await clock.advance(500);
    expect(limiter.delayUntilAllowed()).toBe(0);
  });

  it('never allows more than the burst, however long nothing was taken', async () => {
    const { limiter, clock } = createLimiter();
    await clock.advance(60_000);

    const allowed = [0, 1, 2, 3, 4].map(() => limiter.take());

    expect(allowed).toEqual([true, true, true, true, false]);
  });

  it('is unmoved by the system clock: set back it still refills, set forward it refills no faster', async () => {
    const { limiter, clock } = createLimiter();
    for (let round = 0; round < LIMIT.burst; round += 1) {
      limiter.take();
    }

    // Set forward: no allowance comes back before time has really passed (ADR-0032).
    clock.jumpWallClock(60_000);
    expect(limiter.take()).toBe(false);

    // Set back: what real time brings back still comes back.
    clock.jumpWallClock(-120_000);
    await clock.advance(1_000 / LIMIT.perSecond);
    expect(limiter.take()).toBe(true);
  });
});
