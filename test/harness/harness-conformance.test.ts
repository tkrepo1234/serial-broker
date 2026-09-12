import { describe, expect, it } from 'vitest';

import { FakeClock, flushMicrotasks } from './fake-clock.js';
import { FakeLockManager } from './fake-locks.js';
import { FakeSerialRegistry } from './fake-serial.js';

/**
 * Tests for the fakes themselves.
 *
 * A fake that lies produces tests that lie, and this suite's most important claims - that a
 * killed tab's lock is released, that the longest-waiting tab succeeds it - are claims about
 * the *fake* unless the fake is checked against the specification it stands in for.
 *
 * See docs/guidelines/testing.md.
 */
describe('FakeLockManager', () => {
  const LOCK = 'test-lock';

  it('grants an uncontested lock immediately', async () => {
    const locks = new FakeLockManager();
    let granted = false;

    const held = locks.forContext('a').request(LOCK, { mode: 'exclusive' }, async () => {
      granted = true;
      await new Promise(() => {
        /* holds forever */
      });
    });
    void held;
    await flushMicrotasks();

    expect(granted).toBe(true);
    expect(locks.holderOf(LOCK)).toBe('a');
  });

  it('does not grant a held lock to a second context', async () => {
    const locks = new FakeLockManager();
    let secondGranted = false;

    void locks.forContext('a').request(LOCK, {}, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    void locks.forContext('b').request(LOCK, {}, async () => {
      secondGranted = true;
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    expect(secondGranted).toBe(false);
    expect(locks.queueLength(LOCK)).toBe(1);
  });

  it('grants the lock to the longest-waiting context when the holder releases', async () => {
    const locks = new FakeLockManager();
    const order: string[] = [];
    let release = (): void => undefined;

    void locks.forContext('a').request(LOCK, {}, async () => {
      order.push('a');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await flushMicrotasks();

    for (const id of ['b', 'c']) {
      void locks.forContext(id).request(LOCK, {}, async () => {
        order.push(id);
        await new Promise(() => undefined);
      });
      await flushMicrotasks();
    }

    release();
    await flushMicrotasks();

    // FIFO is what makes failover predictable: the tab that has been waiting longest takes
    // over, not an arbitrary one.
    expect(order).toEqual(['a', 'b']);
    expect(locks.holderOf(LOCK)).toBe('b');
  });

  it('releases the lock when the holding context is destroyed', async () => {
    const locks = new FakeLockManager();
    let successor = false;

    void locks.forContext('a').request(LOCK, {}, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    void locks.forContext('b').request(LOCK, {}, async () => {
      successor = true;
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    // The behaviour the entire failover design rests on, and the one a real browser cannot be
    // asked to perform on cue.
    locks.killContext('a');
    await flushMicrotasks();

    expect(successor).toBe(true);
    expect(locks.holderOf(LOCK)).toBe('b');
  });

  it('rejects a queued request when its signal is aborted', async () => {
    const locks = new FakeLockManager();
    const abort = new AbortController();

    void locks.forContext('a').request(LOCK, {}, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    const queued = locks
      .forContext('b')
      .request(LOCK, { signal: abort.signal }, async () => undefined)
      .catch((error: unknown) => (error as Error).name);
    await flushMicrotasks();

    abort.abort();

    expect(await queued).toBe('AbortError');
    expect(locks.queueLength(LOCK)).toBe(0);
  });

  it('does not revoke a granted lock when its signal is aborted', async () => {
    const locks = new FakeLockManager();
    const abort = new AbortController();

    void locks.forContext('a').request(LOCK, { signal: abort.signal }, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    abort.abort();
    await flushMicrotasks();

    // Aborting a granted lock would break mutual exclusion, which is precisely why the
    // specification has a separate `steal` option that this library never uses.
    expect(locks.holderOf(LOCK)).toBe('a');
  });

  it('passes null to an ifAvailable request when the lock is taken', async () => {
    const locks = new FakeLockManager();
    let observed: unknown = 'not called';

    void locks.forContext('a').request(LOCK, {}, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    await locks.forContext('b').request(LOCK, { ifAvailable: true }, async (lock) => {
      observed = lock;
    });

    expect(observed).toBeNull();
  });
});

describe('FakeClock', () => {
  it('fires timers in due order, then in scheduling order', async () => {
    const clock = new FakeClock();
    const fired: string[] = [];

    clock.setTimer(() => fired.push('late'), 100);
    clock.setTimer(() => fired.push('first-of-two'), 50);
    clock.setTimer(() => fired.push('second-of-two'), 50);

    await clock.advance(100);

    // Ties broken by scheduling order, as browsers do. Without that rule a test could pass
    // or fail depending on Map iteration order.
    expect(fired).toEqual(['first-of-two', 'second-of-two', 'late']);
  });

  it('does not fire a cancelled timer', async () => {
    const clock = new FakeClock();
    let fired = false;

    const handle = clock.setTimer(() => {
      fired = true;
    }, 10);
    clock.clearTimer(handle);
    await clock.advance(100);

    expect(fired).toBe(false);
    expect(clock.pendingTimerCount).toBe(0);
  });

  it('fires a timer scheduled by another timer within the same window', async () => {
    const clock = new FakeClock();
    const fired: number[] = [];

    clock.setTimer(() => {
      fired.push(1);
      clock.setTimer(() => fired.push(2), 10);
    }, 10);

    await clock.advance(50);

    // Backoff schedules its next attempt from inside the previous one; without this, a test
    // would have to advance the clock once per attempt and could not assert a sequence.
    expect(fired).toEqual([1, 2]);
  });

  it('refuses to hang on a timer that reschedules itself with no delay', async () => {
    const clock = new FakeClock();
    const reschedule = (): void => {
      clock.setTimer(reschedule, 0);
    };
    reschedule();

    await expect(clock.advance(1)).rejects.toThrow(/timer storm/);
  });

  it('reports when the next timer is due', () => {
    const clock = new FakeClock();

    expect(clock.nextTimerInMs).toBeUndefined();
    clock.setTimer(() => undefined, 250);
    expect(clock.nextTimerInMs).toBe(250);
  });
});

describe('FakeSerialRegistry', () => {
  it('hides a device until it has been granted', async () => {
    const registry = new FakeSerialRegistry();
    const device = registry.addDevice(1, 2);
    const serial = registry.forContext('tab1');

    expect(await serial.getPorts()).toHaveLength(0);
    registry.grant(device);
    expect(await serial.getPorts()).toHaveLength(1);
  });

  it('shares a granted device with every context, as a per-origin permission does', async () => {
    const registry = new FakeSerialRegistry();
    registry.grant(registry.addDevice(1, 2));

    expect(await registry.forContext('tab1').getPorts()).toHaveLength(1);
    expect(await registry.forContext('tab2').getPorts()).toHaveLength(1);
  });

  it('gives each context its own port object for the same device', async () => {
    const registry = new FakeSerialRegistry();
    registry.grant(registry.addDevice(1, 2));

    const [first] = await registry.forContext('tab1').getPorts();
    const [second] = await registry.forContext('tab2').getPorts();

    // Exactly as the browser does - which is why two tabs opening "the same port" has to be
    // prevented by something other than the object identity.
    expect(first).not.toBe(second);
  });

  it('refuses a second open of a device that is already open', async () => {
    const registry = new FakeSerialRegistry();
    registry.grant(registry.addDevice(1, 2));
    const [first] = await registry.forContext('tab1').getPorts();
    const [second] = await registry.forContext('tab2').getPorts();

    await first?.open({ baudRate: 9600 });

    await expect(second?.open({ baudRate: 9600 })).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('rejects the picker when the user selects nothing', async () => {
    const registry = new FakeSerialRegistry();

    await expect(registry.forContext('tab1').requestPort()).rejects.toMatchObject({
      name: 'NotFoundError',
    });
  });

  it('grants a device the user picks', async () => {
    const registry = new FakeSerialRegistry();
    const device = registry.addDevice(1, 2);
    registry.pickerQueue.push(device);

    await registry.forContext('tab1').requestPort();

    expect(await registry.forContext('tab2').getPorts()).toHaveLength(1);
  });
});
