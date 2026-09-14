import { describe, expect, it } from 'vitest';

import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import type { ClientId, ProtocolMessage, TermId } from '../../src/protocol/messages.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';

import { BrowserHarness } from './browser-harness.js';
import { READER, READER_OPTIONS } from './devices.js';
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

  it('drops the queued requests of a context that is destroyed', async () => {
    const locks = new FakeLockManager();
    let release = (): void => undefined;
    let deadGranted = false;

    void locks.forContext('a').request(LOCK, {}, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await flushMicrotasks();
    void locks.forContext('b').request(LOCK, {}, async () => {
      deadGranted = true;
    });
    await flushMicrotasks();

    // A tab that dies while waiting leaves the queue with it: granting it the lock later would
    // hand ownership to a context that runs no code, and nobody would ever take over.
    locks.killContext('b');
    release();
    await flushMicrotasks();

    expect(deadGranted).toBe(false);
    expect(locks.holderOf(LOCK)).toBeUndefined();
  });

  it('grants a shared lock to several contexts at once', async () => {
    const locks = new FakeLockManager();
    const hold = (contextId: string): void => {
      void locks.forContext(contextId).request(LOCK, { mode: 'shared' }, async () => {
        await new Promise(() => undefined);
      });
    };

    hold('a');
    hold('b');
    await flushMicrotasks();

    expect(locks.holdersOf(LOCK)).toEqual(['a', 'b']);
  });

  it('answers null to an exclusive ifAvailable request while a shared lock is held', async () => {
    const locks = new FakeLockManager();
    let observed: unknown = 'not called';
    void locks.forContext('a').request(LOCK, { mode: 'shared' }, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    await locks.forContext('b').request(LOCK, { ifAvailable: true }, async (lock) => {
      observed = lock;
    });

    expect(observed).toBeNull();
  });

  it('queues a shared request behind an exclusive holder, and grants it on release', async () => {
    const locks = new FakeLockManager();
    let release: () => void = () => undefined;
    void locks.forContext('a').request(LOCK, {}, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await flushMicrotasks();
    void locks.forContext('b').request(LOCK, { mode: 'shared' }, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();
    expect(locks.holdersOf(LOCK)).toEqual(['a']);

    release();
    await flushMicrotasks();

    expect(locks.holdersOf(LOCK)).toEqual(['b']);
  });

  it('keeps a shared request queued behind an earlier exclusive request, in order', async () => {
    const locks = new FakeLockManager();
    let releaseShared: () => void = () => undefined;
    void locks.forContext('a').request(LOCK, { mode: 'shared' }, async () => {
      await new Promise<void>((resolve) => {
        releaseShared = resolve;
      });
    });
    await flushMicrotasks();
    void locks.forContext('b').request(LOCK, {}, async () => undefined);
    void locks.forContext('c').request(LOCK, { mode: 'shared' }, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    // Granting `c` alongside `a` would starve `b`, which asked first.
    expect(locks.holdersOf(LOCK)).toEqual(['a']);
    releaseShared();
    await flushMicrotasks();
    expect(locks.holdersOf(LOCK)).toEqual(['c']);
  });

  it('releases the shared locks of a context that is destroyed', async () => {
    const locks = new FakeLockManager();
    void locks.forContext('a').request(LOCK, { mode: 'shared' }, async () => {
      await new Promise(() => undefined);
    });
    await flushMicrotasks();

    locks.killContext('a');

    expect(locks.holdersOf(LOCK)).toEqual([]);
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

  it('moves the wall clock without moving a timer, as a change of the system time does', async () => {
    const clock = new FakeClock();
    const startedAt = clock.now();
    let fired = false;
    clock.setTimer(() => {
      fired = true;
    }, 1_000);

    clock.jumpWallClock(-3_600_000);
    await clock.advance(999);
    const beforeDue = fired;
    await clock.advance(1);

    expect(beforeDue).toBe(false);
    expect(fired).toBe(true);
    expect(clock.now()).toBe(startedAt - 3_600_000 + 1_000);
  });

  it('keeps the monotonic reading out of the wall clock`s jumps', async () => {
    const clock = new FakeClock();
    const startedAt = clock.monotonicNow();

    clock.jumpWallClock(-3_600_000);
    await clock.advance(1_000);
    clock.jumpWallClock(7_200_000);

    // What `performance.now()` does while `Date.now()` is moved: a duration measured on it is the
    // time that really passed (ADR-0032).
    expect(clock.monotonicNow() - startedAt).toBe(1_000);
  });

  it('lets time pass without running a timer, and runs it late afterwards', async () => {
    const clock = new FakeClock();
    let lateness: number | undefined;
    const dueAt = clock.monotonicNow() + 100;
    clock.setTimer(() => (lateness = clock.monotonicNow() - dueAt), 100);

    // A frozen tab, a throttled one, a sleeping machine: time goes on and no timer runs.
    await clock.stall(5_000);
    expect(lateness).toBeUndefined();
    await clock.advance(0);

    expect(lateness).toBe(4_900);
    expect(clock.pendingTimerCount).toBe(0);
  });
});

/**
 * A frozen context, as the Page Lifecycle API defines it: its task queues are not run, while time
 * and every other context go on.
 */
describe('BrowserHarness frozen contexts', () => {
  const CONFIG = 'Reader';

  function releasedBy(from: string, term = `term-of-${from}`): ProtocolMessage {
    return {
      type: 'owner-released',
      v: PROTOCOL_VERSION,
      from: from as ClientId,
      to: 'all',
      configName: CONFIG,
      term: term as TermId,
    };
  }

  function listeningTransport(harness: BrowserHarness, contextId: string, heard: string[]) {
    return harness.createEnvironment(contextId).createTransport({
      clientId: contextId as ClientId,
      onMessage: (message) => heard.push(`${message.type} from ${message.from}`),
      onDecodeFailure: () => undefined,
      onTransportError: () => undefined,
      logger: new ScopedLogger(NOOP_LOGGER, {}),
      clock: harness.busClock,
      newSecret: () => 'secret',
    });
  }

  it('holds the timers that fall due while frozen, and fires them on resume', async () => {
    const harness = new BrowserHarness();
    const clock = harness.createEnvironment('frozen').clock;
    let fired = 0;
    clock.setTimer(() => (fired += 1), 100);

    harness.freezeContext('frozen');
    await harness.advance(60_000);
    const whileFrozen = fired;
    await harness.resumeContext('frozen');

    expect(whileFrozen).toBe(0);
    expect(fired).toBe(1);
  });

  it('holds the messages that arrive while frozen, and hands them over in order on resume', async () => {
    const harness = new BrowserHarness({ transport: 'broadcastchannel' });
    const heard: string[] = [];
    const frozen = listeningTransport(harness, 'frozen', heard);
    frozen.attach(CONFIG);
    const sender = listeningTransport(harness, 'sender', []);
    await harness.settle();
    heard.splice(0);

    harness.freezeContext('frozen');
    sender.send(releasedBy('sender'));
    sender.send(releasedBy('sender', 'second'));
    await harness.settle();
    const whileFrozen = heard.length;
    await harness.resumeContext('frozen');

    expect(whileFrozen).toBe(0);
    expect(heard).toEqual(['owner-released from sender', 'owner-released from sender']);
  });

  it('runs held timers before held messages, or after them, as the test chooses', async () => {
    const harness = new BrowserHarness({ transport: 'broadcastchannel' });
    const heard: string[] = [];
    const frozen = listeningTransport(harness, 'frozen', heard);
    frozen.attach(CONFIG);
    const sender = listeningTransport(harness, 'sender', []);
    await harness.settle();
    heard.splice(0);
    harness.createEnvironment('frozen').clock.setTimer(() => heard.push('timer'), 10);

    harness.freezeContext('frozen');
    sender.send(releasedBy('sender'));
    await harness.advance(10);
    await harness.resumeContext('frozen', 'timers-first');

    expect(heard).toEqual(['timer', 'owner-released from sender']);
  });

  it('runs the microtasks a held task queued before the next held task', async () => {
    const harness = new BrowserHarness();
    const clock = harness.createEnvironment('frozen').clock;
    const order: string[] = [];
    clock.setTimer(() => {
      order.push('first task');
      void Promise.resolve().then(() => order.push('its microtask'));
    }, 10);
    clock.setTimer(() => order.push('second task'), 20);

    harness.freezeContext('frozen');
    await harness.advance(20);
    await harness.resumeContext('frozen');

    expect(order).toEqual(['first task', 'its microtask', 'second task']);
  });

  it('grants a lock to a frozen context and runs its callback only when it resumes', async () => {
    const harness = new BrowserHarness();
    const locks = harness.createEnvironment('frozen').locks;
    let ran = false;

    harness.freezeContext('frozen');
    void locks.request('test-lock', { mode: 'exclusive' }, async () => {
      ran = true;
      await new Promise(() => {
        /* holds forever */
      });
    });
    await harness.settle();
    const holderWhileFrozen = harness.locks.holderOf('test-lock');
    const ranWhileFrozen = ran;
    await harness.resumeContext('frozen');

    expect(holderWhileFrozen).toBe('frozen');
    expect(ranWhileFrozen).toBe(false);
    expect(ran).toBe(true);
  });

  it('never runs what a frozen tab held once the tab is discarded', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup(CONFIG, READER_OPTIONS);
    let fired = false;
    harness.createEnvironment(tab.id).clock.setTimer(() => (fired = true), 10);

    tab.freeze();
    await tab.kill();
    await harness.advance(10);
    await harness.resumeContext(tab.id);

    expect(fired).toBe(false);
  });

  it('does not run a held timer that was cleared before the tab resumed', async () => {
    const harness = new BrowserHarness();
    const clock = harness.createEnvironment('frozen').clock;
    let fired = false;
    const handle = clock.setTimer(() => (fired = true), 10);

    harness.freezeContext('frozen');
    await harness.advance(10);
    clock.clearTimer(handle);
    await harness.resumeContext('frozen');

    expect(fired).toBe(false);
  });
});

/**
 * A tab hidden for more than five minutes has its timers run in a batch once a minute (Chromium's
 * intensive throttling), while its messages and events are delivered as they arrive.
 */
describe('BrowserHarness throttled timers', () => {
  it('holds only the timers, and runs them at the boundary, while messages go on', async () => {
    const harness = new BrowserHarness({ transport: 'broadcastchannel' });
    const environment = harness.createEnvironment('hidden');
    const heard: string[] = [];
    const hidden = environment.createTransport({
      clientId: 'hidden' as ClientId,
      onMessage: (message) => heard.push(message.type),
      onDecodeFailure: () => undefined,
      onTransportError: () => undefined,
      logger: new ScopedLogger(NOOP_LOGGER, {}),
      clock: harness.busClock,
      newSecret: () => 'secret',
    });
    hidden.attach('Reader');
    const sender = harness.createEnvironment('sender').createTransport({
      clientId: 'sender' as ClientId,
      onMessage: () => undefined,
      onDecodeFailure: () => undefined,
      onTransportError: () => undefined,
      logger: new ScopedLogger(NOOP_LOGGER, {}),
      clock: harness.busClock,
      newSecret: () => 'secret',
    });
    await harness.settle();
    heard.splice(0);
    environment.clock.setTimer(() => heard.push('timer'), 10);

    harness.throttleTimers('hidden');
    await harness.advance(60_000);
    sender.send({
      type: 'owner-released',
      v: PROTOCOL_VERSION,
      from: 'sender' as ClientId,
      to: 'all',
      configName: 'Reader',
      term: 'term' as TermId,
    });
    await harness.settle();
    const beforeBoundary = [...heard];
    await harness.runThrottledTimers('hidden');

    expect(beforeBoundary).toEqual(['owner-released']);
    expect(heard).toEqual(['owner-released', 'timer']);
  });

  it('keeps a timer that falls due after the boundary for the next one', async () => {
    const harness = new BrowserHarness();
    const clock = harness.createEnvironment('hidden').clock;
    const fired: string[] = [];
    clock.setTimer(() => fired.push('first'), 10);

    harness.throttleTimers('hidden');
    await harness.advance(60_000);
    await harness.runThrottledTimers('hidden');
    clock.setTimer(() => fired.push('second'), 10);
    await harness.advance(60_000);
    const afterFirstBoundary = [...fired];
    await harness.stopThrottlingTimers('hidden');

    expect(afterFirstBoundary).toEqual(['first']);
    expect(fired).toEqual(['first', 'second']);
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

  it('does not list a granted device while it is unplugged', async () => {
    const registry = new FakeSerialRegistry();
    const device = registry.addDevice(1, 2);
    registry.grant(device);
    const serial = registry.forContext('tab1');

    registry.unplug(device);
    expect(await serial.getPorts()).toHaveLength(0);
    registry.plug(device);
    expect(await serial.getPorts()).toHaveLength(1);
  });

  it('refuses to close a port whose readable stream is still locked', async () => {
    const registry = new FakeSerialRegistry();
    registry.grant(registry.addDevice(1, 2));
    const [port] = await registry.forContext('tab1').getPorts();
    await port!.open({ baudRate: 9600 });

    const reader = port!.readable!.getReader();
    await expect(port!.close()).rejects.toThrow(TypeError);

    reader.releaseLock();
    await expect(port!.close()).resolves.toBeUndefined();
  });

  it('releases the devices of a context that goes away, whatever their streams', async () => {
    const registry = new FakeSerialRegistry();
    const device = registry.addDevice(1, 2);
    registry.grant(device);
    const [first] = await registry.forContext('tab1').getPorts();
    await first!.open({ baudRate: 9600 });
    first!.readable!.getReader();

    registry.removeContext('tab1');
    const [second] = await registry.forContext('tab2').getPorts();

    await expect(second!.open({ baudRate: 9600 })).resolves.toBeUndefined();
    expect(device.openCount).toBe(2);
  });

  it('does not let a port object from before an unplug release the device opened since', async () => {
    const registry = new FakeSerialRegistry();
    const device = registry.addDevice(1, 2);
    registry.grant(device);
    const [stale] = await registry.forContext('tab1').getPorts();
    await stale!.open({ baudRate: 9600 });
    registry.unplug(device);
    registry.plug(device);
    const [current] = await registry.forContext('tab2').getPorts();
    await current!.open({ baudRate: 9600 });

    // tab1 tidies up after the loss. That must not free the device tab2 holds now, or a third
    // context could open it alongside tab2 - which no browser allows.
    registry.removeContext('tab1');

    expect(device.isOpen).toBe(true);
    const [third] = await registry.forContext('tab3').getPorts();
    await expect(third!.open({ baudRate: 9600 })).rejects.toMatchObject({
      name: 'InvalidStateError',
    });
  });

  it('offers in the picker only a device the filters match', async () => {
    const registry = new FakeSerialRegistry();
    const device = registry.addDevice(1, 2);
    registry.pickerQueue.push(device);

    await expect(
      registry.forContext('tab1').requestPort({ filters: [{ usbVendorId: 9 }] }),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
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
