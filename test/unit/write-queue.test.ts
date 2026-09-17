import { describe, expect, it, vi } from 'vitest';

import { WriteQueue } from '../../src/owner/write-queue.js';
import { flushMicrotasks } from '../harness/fake-clock.js';

function enqueue<T>(queue: WriteQueue, job: () => Promise<T>): Promise<T> {
  return queue.enqueueWithdrawable(job).promise;
}

/** A job that runs until the test lets it finish. */
function heldJob(events: string[], name: string) {
  let finish: () => void = () => undefined;
  const job = async (): Promise<void> => {
    events.push(`${name}:start`);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    events.push(`${name}:end`);
  };
  return { job, finish: () => finish() };
}

describe('WriteQueue', () => {
  it('runs jobs one after another, never overlapping', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];

    const first = enqueue(queue, async () => {
      events.push('first:start');
      await Promise.resolve();
      events.push('first:end');
    });
    const second = enqueue(queue, async () => {
      events.push('second:start');
      await Promise.resolve();
      events.push('second:end');
    });
    await Promise.all([first, second]);

    // Interleaving here means two commands reaching the device byte by byte, which for a
    // command-oriented device means neither of them.
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('keeps running after a job fails, and reports the failure only to its caller', async () => {
    const queue = new WriteQueue();
    const after = vi.fn();

    const failing = enqueue(queue, async () => {
      await Promise.resolve();
      throw new Error('the device refused');
    });
    const next = enqueue(queue, async () => {
      after();
      await Promise.resolve();
      return 'ok';
    });

    await expect(failing).rejects.toThrow('the device refused');
    await expect(next).resolves.toBe('ok');
    expect(after).toHaveBeenCalledOnce();
  });

  it('tracks how much work is outstanding, and drains when nothing is', async () => {
    const queue = new WriteQueue();

    const job = enqueue(queue, async () => {
      await Promise.resolve();
    });
    expect(queue.depth).toBe(1);

    await job;
    await queue.drain();
    expect(queue.depth).toBe(0);
  });
});

/**
 * Withdrawing a write that waits at the port (ADR-0011): a write whose issuer has stopped waiting is
 * taken out of the queue at once, so that it is never begun and holds no memory while the write in
 * front of it goes on.
 */
describe('WriteQueue withdrawal', () => {
  it('never runs a withdrawn job, and rejects its promise with the reason given', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];
    const running = heldJob(events, 'running');
    void queue.enqueueWithdrawable(running.job).promise;
    const waiting = queue.enqueueWithdrawable(async () => {
      events.push('waiting:start');
      await Promise.resolve();
    });
    const outcome = waiting.promise.catch((error: unknown) => error);
    await flushMicrotasks();

    const withdrawn = waiting.withdraw(new Error('gave up'));
    running.finish();
    await flushMicrotasks();

    expect(withdrawn).toBe(true);
    expect(await outcome).toMatchObject({ message: 'gave up' });
    expect(events).toEqual(['running:start', 'running:end']);
  });

  it('takes a withdrawn job out of the depth at once, while the job in front still runs', async () => {
    const queue = new WriteQueue();
    const running = heldJob([], 'running');
    void queue.enqueueWithdrawable(running.job).promise;
    const waiting = queue.enqueueWithdrawable(() => Promise.resolve());
    void waiting.promise.catch(() => undefined);
    await flushMicrotasks();

    waiting.withdraw(new Error('gave up'));

    expect(queue.depth).toBe(1);
    running.finish();
  });

  it('does not withdraw a job that has begun, and lets it finish', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];
    const running = heldJob(events, 'running');
    const queued = queue.enqueueWithdrawable(running.job);
    await flushMicrotasks();

    const withdrawn = queued.withdraw(new Error('too late'));
    running.finish();
    await queued.promise;

    expect(withdrawn).toBe(false);
    expect(events).toEqual(['running:start', 'running:end']);
  });

  it('runs the jobs behind a withdrawn one, in order', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];
    const running = heldJob(events, 'first');
    void queue.enqueueWithdrawable(running.job).promise;
    const withdrawn = queue.enqueueWithdrawable(async () => {
      events.push('withdrawn:start');
      await Promise.resolve();
    });
    void withdrawn.promise.catch(() => undefined);
    const last = enqueue(queue, async () => {
      events.push('last:start');
      await Promise.resolve();
    });
    await flushMicrotasks();

    withdrawn.withdraw(new Error('gave up'));
    running.finish();
    await last;

    expect(events).toEqual(['first:start', 'first:end', 'last:start']);
  });

  it('drains the jobs queued before the call, withdrawn ones included, and not later ones', async () => {
    const queue = new WriteQueue();
    const events: string[] = [];
    const running = heldJob(events, 'running');
    void queue.enqueueWithdrawable(running.job).promise;
    const withdrawn = queue.enqueueWithdrawable(() => Promise.resolve());
    void withdrawn.promise.catch(() => undefined);
    let drained = false;
    const draining = queue.drain().then(() => {
      drained = true;
    });
    const later = heldJob(events, 'later');
    void queue.enqueueWithdrawable(later.job).promise;
    await flushMicrotasks();

    withdrawn.withdraw(new Error('gave up'));
    await flushMicrotasks();
    const drainedWhileRunning = drained;
    running.finish();
    await draining;

    expect(drainedWhileRunning).toBe(false);
    expect(drained).toBe(true);
    expect(events).toContain('later:start');
    expect(events).not.toContain('later:end');
    later.finish();
  });
});
