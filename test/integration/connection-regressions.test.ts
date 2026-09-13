import { describe, expect, it } from 'vitest';

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import type { SerialLike } from '../../src/environment/environment.js';
import { OwnershipElection } from '../../src/owner/election.js';
import { ownerLockName } from '../../src/protocol/version.js';
import { BrowserHarness, VirtualTab } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { FakeClock, flushMicrotasks } from '../harness/fake-clock.js';
import { FakeLockManager } from '../harness/fake-locks.js';

/**
 * Defects in how the tab holding the port connects, loses and hands over the connection, found in
 * the review of 2026-09-13 and each pinned by the behaviour it broke. See ADR-0010.
 */

/** Levers on the browser's timing that the plain harness does not offer. */
interface SerialTiming {
  /** `getPorts()` never answers while this is set. */
  listingHangs: boolean;
  /**
   * Milliseconds, on the harness clock, that `open()` takes to settle after the device is opened.
   *
   * In Chromium the browser process holds the device before the reply reaches the page.
   */
  openDelayMs: number;
  /**
   * Milliseconds, on the harness clock, before `close()` does anything.
   *
   * In Chromium `close()` is a round trip to the browser process, and the device stays open until
   * it returns.
   */
  closeDelayMs: number;
}

/**
 * Opens a tab whose `navigator.serial` answers with the timing a test sets.
 *
 * The id must differ from the `tabN` ids `openTab()` hands out: tabs sharing an id share their
 * port objects and their place in the lock queue.
 */
function openSlowTab(
  harness: BrowserHarness,
  id: string,
): { tab: VirtualTab; timing: SerialTiming } {
  const timing: SerialTiming = { listingHangs: false, openDelayMs: 0, closeDelayMs: 0 };
  const environment = harness.createEnvironment(id);
  const serial = environment.serial;
  const patched = new WeakSet<SerialPort>();

  const wait = async (delayMs: number): Promise<void> => {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        harness.clock.setTimer(resolve, delayMs);
      });
    }
  };

  const slowSerial: SerialLike = {
    getPorts: async () => {
      if (timing.listingHangs) {
        return await new Promise<never>(() => {
          /* intentionally never settles */
        });
      }
      const ports = await serial.getPorts();
      for (const port of ports) {
        if (patched.has(port)) {
          continue;
        }
        patched.add(port);
        const open = port.open.bind(port);
        const close = port.close.bind(port);
        Object.assign(port, {
          open: async (options: SerialOptions) => {
            await open(options);
            await wait(timing.openDelayMs);
          },
          close: async () => {
            await wait(timing.closeDelayMs);
            await close();
          },
        });
      }
      return ports;
    },
    requestPort: async (options) => await serial.requestPort(options),
    addEventListener: (type, listener) => {
      serial.addEventListener(type, listener);
    },
    removeEventListener: (type, listener) => {
      serial.removeEventListener(type, listener);
    },
  };

  const client = new SerialBrokerClient({ ...environment, serial: slowSerial });
  return { tab: new VirtualTab(id, client, harness), timing };
}

function errorCodes(tab: VirtualTab): string[] {
  return tab.recordFor('Reader').errors.map((event) => event.error.code);
}

function connectionState(tab: VirtualTab): string | undefined {
  return tab.client.diagnostics()?.configurations[0]?.connection?.state;
}

describe('listing the granted ports', () => {
  it('keeps retrying when listing the ports hangs during a reconnect', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const { tab, timing } = openSlowTab(harness, 'slow-tab');
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { openTimeoutMs: 1_000 } });

    timing.listingHangs = true;
    device.breakStream();
    await harness.settle();
    await harness.advance(0);
    await harness.advance(1_000);
    await harness.advance(120_000);

    // A browser that never answers is a failed attempt, and a failed attempt is followed by
    // another one - not by a connection that stays `connecting` with nothing scheduled.
    expect(
      errorCodes(tab).filter((code) => code === SerialBrokerErrorCode.OPEN_TIMEOUT).length,
    ).toBeGreaterThan(1);

    timing.listingHangs = false;
    await harness.advance(60_000);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('reports the connection as opening while the ports are listed for the first time', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const { tab, timing } = openSlowTab(harness, 'slow-tab');
    timing.listingHangs = true;

    await tab.setup('Reader', READER_OPTIONS);

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Connecting);
    expect(connectionState(tab)).toBe('opening');
  });

  it('reports the connection as opening, with no attempt scheduled, while a retry lists the ports', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const { tab, timing } = openSlowTab(harness, 'slow-tab');
    await tab.setup('Reader', READER_OPTIONS);

    timing.listingHangs = true;
    device.breakStream();
    await harness.settle();
    await harness.advance(0);

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Connecting);
    expect(connectionState(tab)).toBe('opening');
    expect(tab.client.diagnostics()?.configurations[0]?.connection?.nextAttemptAt).toBeUndefined();
  });
});

describe('retrying after a lost connection', () => {
  it('waits for the lost connection to close before opening the port again', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const { tab, timing } = openSlowTab(harness, 'slow-tab');
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { maxAttempts: 2 } });

    timing.closeDelayMs = 5;
    device.breakStream(new Error('framing error'));
    await harness.settle();
    await harness.advance(0);
    await harness.advance(5);
    await harness.advance(1_000);

    // Opening while the old connection is still closing fails with InvalidStateError: an error
    // about nothing in every tab, and one attempt used up - with two allowed, the last one.
    expect(errorCodes(tab)).toEqual([SerialBrokerErrorCode.READ_FAILED]);
    expect(tab.statusTrail('Reader').at(-1)).toBe(SerialBrokerStatus.Open);
  });
});

describe('a device event for another port', () => {
  it('keeps a connection that accepts any port when a different port is unplugged', async () => {
    const harness = new BrowserHarness();
    const held = harness.serial.addDevice(READER.vendorId, READER.productId);
    const other = harness.serial.addDevice(0x0403, 0x6001);
    harness.serial.grant(held);
    harness.serial.grant(other);
    const tab = harness.openTab();
    await tab.setup('Reader', { device: { any: true }, serial: { baudRate: 9600 } });
    expect(held.isOpen).toBe(true);

    harness.serial.unplug(other);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(tab.recordFor('Reader').errors).toHaveLength(0);
    expect(held.openCount).toBe(1);
  });

  it('keeps the connection when an identical device is unplugged', async () => {
    const harness = new BrowserHarness();
    const held = harness.serial.addDevice(READER.vendorId, READER.productId);
    const twin = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(held);
    harness.serial.grant(twin);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    expect(held.isOpen).toBe(true);

    harness.serial.unplug(twin);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(tab.recordFor('Reader').errors).toHaveLength(0);
    expect(held.openCount).toBe(1);
  });
});

describe('handing the port over', () => {
  it('does not let the next tab open the port before a pending open has been closed', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const { tab: first, timing } = openSlowTab(harness, 'slow-tab');
    timing.openDelayMs = 50;
    await first.setup('Reader', READER_OPTIONS);
    const second = harness.openTab();
    await second.setup('Reader', READER_OPTIONS);
    expect(first.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Connecting);

    const released = first.client.release('Reader');
    await harness.settle();
    await harness.advance(50);
    await released;
    await harness.settle();

    // Releasing before the port is closed hands the lock to a tab that then finds the device
    // still held, and every tab hears about an OPEN_FAILED that describes nothing (ADR-0005).
    expect(second.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(errorCodes(second)).toEqual([]);
    expect(device.openCount).toBe(2);
  });

  it('does not let the next tab open the port while a lost connection is still closing', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const { tab: first, timing } = openSlowTab(harness, 'slow-tab');
    await first.setup('Reader', READER_OPTIONS);
    const second = harness.openTab();
    await second.setup('Reader', READER_OPTIONS);

    timing.closeDelayMs = 5;
    device.breakStream(new Error('framing error'));
    await harness.settle();
    const released = first.client.release('Reader');
    await harness.settle();
    await harness.advance(5);
    await released;
    await harness.settle();

    expect(second.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(errorCodes(second)).toEqual([SerialBrokerErrorCode.READ_FAILED]);
  });
});

describe('an unplugged device', () => {
  async function connectedTab(connection = {}): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    tab: VirtualTab;
  }> {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection });
    return { harness, device, tab };
  }

  it('stays reconnecting, not awaiting permission, while it is away', async () => {
    const { harness, device, tab } = await connectedTab();

    harness.serial.unplug(device);
    await harness.advance(10_000);

    // The browser does not list a detached port, but the user did not take their permission
    // away: asking for it again would be a button that does nothing.
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Reconnecting);
    expect(tab.statusTrail('Reader')).not.toContain(SerialBrokerStatus.AwaitingPermission);

    harness.serial.plug(device);
    await harness.settle();
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('backs off while it is away, and gives up after maxAttempts', async () => {
    const { harness, device, tab } = await connectedTab({ maxAttempts: 4 });

    harness.serial.unplug(device);
    await harness.settle();
    const delays: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      delays.push(harness.clock.nextTimerInMs ?? -1);
      await harness.clock.advanceToNextTimer();
      await harness.settle();
    }

    expect(delays).toEqual([0, 250, 500]);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);
    expect(errorCodes(tab)).toEqual([
      SerialBrokerErrorCode.DEVICE_DISCONNECTED,
      SerialBrokerErrorCode.RECONNECT_EXHAUSTED,
    ]);
  });

  it('reconnects when the disconnect event arrives after the port was already missing', async () => {
    const { harness, device, tab } = await connectedTab();

    // In Chromium the read error and the `disconnect` event travel separately, and a retry can
    // find the port gone before the event has said why.
    device.isAttached = false;
    device.breakStream();
    await harness.settle();
    await harness.advance(0);
    harness.serial.unplug(device);
    await harness.advance(1_000);

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Reconnecting);

    harness.serial.plug(device);
    await harness.settle();
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('waits for permission when the permission is revoked while connected', async () => {
    const { harness, device, tab } = await connectedTab();

    // No `disconnect` event: the device is still there, the permission is not.
    harness.serial.revoke(device);
    device.breakStream();
    await harness.settle();
    await harness.advance(10_000);

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.AwaitingPermission);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });
});

describe('leaving the election', () => {
  it('lets go of a lock that was granted but whose callback has not run yet', async () => {
    const locks = new FakeLockManager();
    const clock = new FakeClock();
    const logger = new ScopedLogger(NOOP_LOGGER, {});
    const lockName = ownerLockName('Reader');
    const acquired: string[] = [];
    const elect = (contextId: string): OwnershipElection =>
      new OwnershipElection(
        locks.forContext(contextId),
        'Reader',
        { onAcquired: () => acquired.push(contextId), onLost: () => undefined },
        logger,
        clock,
      );

    const holder = elect('tab1');
    holder.start();
    await flushMicrotasks();
    const successor = elect('tab2');
    successor.start();
    await flushMicrotasks();
    expect(locks.holderOf(lockName)).toBe('tab1');

    // The browser grants the lock to the successor in the same turn in which it stops.
    locks.killContext('tab1');
    successor.stop();
    await flushMicrotasks();

    expect(locks.holderOf(lockName)).toBeUndefined();
    expect(acquired).toEqual(['tab1']);
  });
});
