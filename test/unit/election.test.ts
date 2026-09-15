import { describe, expect, it } from 'vitest';

import { LOCK_RETRY_DELAY_MS } from '../../src/core/held-lock.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import type { LockManagerLike } from '../../src/environment/environment.js';
import { OwnershipElection } from '../../src/owner/election.js';
import type { TermId } from '../../src/protocol/messages.js';
import { FakeClock, flushMicrotasks } from '../harness/fake-clock.js';

const NEW_TERM = () => ({ term: 't-1' as TermId, lockName: 'term-lock' });

describe('OwnershipElection', () => {
  it('pauses before requesting the lock again after a request failed', async () => {
    let requests = 0;
    // A browser that refuses the request outright, as a restrictive policy can.
    const locks = {
      request: async () => {
        requests += 1;
        await Promise.resolve();
        throw new Error('The request was denied');
      },
    } as unknown as LockManagerLike;
    const clock = new FakeClock();
    const election = new OwnershipElection(
      locks,
      'Reader',
      { newTerm: NEW_TERM, onAcquired: () => undefined, onLost: () => undefined },
      new ScopedLogger(NOOP_LOGGER, {}),
      clock,
    );

    election.start();
    await flushMicrotasks(20);
    // Asking again at once would repeat in an endless chain of microtasks.
    expect(requests).toBe(1);

    await clock.advance(LOCK_RETRY_DELAY_MS);
    await flushMicrotasks(20);
    expect(requests).toBe(2);

    void election.stop();
    await clock.advance(LOCK_RETRY_DELAY_MS * 5);
    await flushMicrotasks(20);
    expect(requests).toBe(2);
  });

  it('requests the lock again after a failure whose error cannot be printed', async () => {
    let requests = 0;
    const unprintable = new Error('denied');
    Object.defineProperty(unprintable, 'name', {
      get: () => {
        throw new Error('no name for you');
      },
    });
    const locks = {
      request: async () => {
        requests += 1;
        await Promise.resolve();
        throw unprintable;
      },
    } as unknown as LockManagerLike;
    const clock = new FakeClock();
    const election = new OwnershipElection(
      locks,
      'Reader',
      { newTerm: NEW_TERM, onAcquired: () => undefined, onLost: () => undefined },
      new ScopedLogger(NOOP_LOGGER, {}),
      clock,
    );

    election.start();
    await flushMicrotasks(20);
    await clock.advance(LOCK_RETRY_DELAY_MS);
    await flushMicrotasks(20);

    // Describing the failure for the log must not be what takes the context out of the election.
    expect(requests).toBe(2);
    void election.stop();
  });
});
