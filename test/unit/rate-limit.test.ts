import { describe, expect, it } from 'vitest';

import { ScopedLogger } from '../../src/core/logger.js';
import { RateLimiter, type RateLimit } from '../../src/core/rate-limit.js';
import { FakeClock } from '../harness/fake-clock.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

const LIMIT: RateLimit = { burst: 4, perSecond: 2 };

function createLimiter(limit: RateLimit = LIMIT): {
  limiter: RateLimiter;
  clock: FakeClock;
  records: ReturnType<typeof recordingLogger>['records'];
} {
  const clock = new FakeClock();
  const { logger, records } = recordingLogger();
  const limiter = new RateLimiter(
    limit,
    clock,
    new ScopedLogger(logger, {}),
    'test.dropped',
    'messages',
  );
  return { limiter, clock, records };
}

/**
 * The bound on how often the bus may make a context work (ADR-0031).
 *
 * A burst is what legitimate use looks like; a flood is what a broken or hostile sender looks
 * like. What is dropped is logged once, because a record per dropped message only moves the flood
 * into the log an operator has to read.
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

  it('logs the first drop and no other', () => {
    const { limiter, records } = createLimiter();

    for (let round = 0; round < 100; round += 1) {
      limiter.take();
    }

    expect(fieldsOfEvent(records, 'test.dropped')).toEqual([
      { event: 'test.dropped', burst: LIMIT.burst, perSecond: LIMIT.perSecond },
    ]);
  });

  it('refills nothing while the system clock is set back', () => {
    const { limiter, clock } = createLimiter();
    for (let round = 0; round < LIMIT.burst; round += 1) {
      limiter.take();
    }

    clock.jumpWallClock(-60_000);

    expect(limiter.take()).toBe(false);
  });
});
