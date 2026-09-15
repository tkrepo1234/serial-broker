import { describe, expect, it } from 'vitest';

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import type {
  SerialLike,
  SerialOptionsLike,
  SerialPortLike,
} from '../../src/environment/environment.js';
import { OwnershipElection } from '../../src/owner/election.js';
import { ownerLockName } from '../../src/protocol/version.js';
import { BrowserHarness, VirtualTab } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { FakeClock, flushMicrotasks } from '../harness/fake-clock.js';
import { FakeLockManager } from '../harness/fake-locks.js';
import { domException } from '../harness/fake-serial.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

/**
 * Defects in how the tab holding the port connects, loses and hands over the connection, found in
 * the review of 2026-09-13 and each pinned by the behaviour it broke. See ADR-0010.
 */

/** Levers on the browser's timing that the plain harness does not offer. */
interface SerialTiming {
  /** `getPorts()` never answers while this is set. */
  listingHangs: boolean;
  /** `getPorts()` rejects with this while it is set, as under a restrictive permissions policy. */
  listingFailsWith: Error | undefined;
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
  const timing: SerialTiming = {
    listingHangs: false,
    listingFailsWith: undefined,
    openDelayMs: 0,
    closeDelayMs: 0,
  };
  const environment = harness.createEnvironment(id);
  const serial = environment.serial;
  const patched = new WeakSet<SerialPortLike>();

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
      if (timing.listingFailsWith !== undefined) {
        throw timing.listingFailsWith;
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
          open: async (options: SerialOptionsLike) => {
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
      tab.errorCodes('Reader').filter((code) => code === SerialBrokerErrorCode.OPEN_TIMEOUT).length,
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

describe('an attempt to connect', () => {
  it('looks again for a device plugged in during the listing as part of the same attempt', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    harness.serial.unplug(device);
    harness.serial.onListingPorts = () => {
      harness.serial.onListingPorts = undefined;
      harness.serial.plug(device);
    };

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // Counted twice, a configuration allowed one attempt would give up after a first attempt that
    // only had to look again.
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(tab.client.diagnostics()?.configurations[0]?.connection?.attempt).toBe(1);
  });

  it('numbers an attempt alike in its error, its log record and the diagnostics', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'InvalidStateError';

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    const [failure] = tab.recordFor('Reader').errors;
    expect(failure?.error.context['attempt']).toBe(1);
    expect(fieldsOfEvent(records, 'supervisor.reconnect')[0]?.['attempt']).toBe(1);
    expect(tab.client.diagnostics()?.configurations[0]?.connection?.attempt).toBe(1);
  });

  it('reports ports that cannot be listed with the time it happened', async () => {
    const harness = new BrowserHarness();
    const { tab, timing } = openSlowTab(harness, 'slow-tab');
    timing.listingFailsWith = domException('SecurityError', 'Access to serial is disallowed');

    await tab.setup('Reader', READER_OPTIONS);

    const [failure] = tab.recordFor('Reader').errors;
    expect(failure?.error.code).toBe(SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE);
    expect(failure?.error.timestamp).toBe(harness.clock.now());
  });
});

describe('a device plugged in again', () => {
  it('is logged when it revives a configuration that had given up', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'NetworkError';
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { maxAttempts: 1 } });
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);

    device.faults.failOpenWith = undefined;
    harness.serial.plug(device);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(fieldsOfEvent(records, 'supervisor.device-connected')).toHaveLength(1);
  });
});

describe('closing a lost connection', () => {
  it('records a teardown step that failed, which the next open may run into', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    harness.serial.unplug(device);
    await harness.settle();

    // The reader of a stream that errored cannot be cancelled cleanly. Nothing is reported for it -
    // the unplugging already was - but a close that fails silently leaves nothing to go on when
    // the next open finds the device still open.
    expect(
      fieldsOfEvent(records, 'supervisor.teardown-failed').map((fields) => fields['step']),
    ).toContain('cancelling the reader');
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
    expect(tab.errorCodes('Reader')).toEqual([SerialBrokerErrorCode.READ_FAILED]);
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
    expect(second.errorCodes('Reader')).toEqual([]);
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
    expect(second.errorCodes('Reader')).toEqual([SerialBrokerErrorCode.READ_FAILED]);
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
    expect(tab.errorCodes('Reader')).toEqual([
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

describe('a device that stops taking writes', () => {
  // Measured in Chromium on Windows against the USB/IP emulator: a write the device has not taken
  // cannot be aborted, and a port with one outstanding neither closes nor opens again, however soon
  // the device recovers. Tearing the connection down for a write timeout therefore made recovery
  // impossible. See ADR-0038.

  /** Past the deadline of the tab holding the port, which starts the write a little after `send()`. */
  const PAST_THE_DEADLINE_MS = 2_000;

  async function connectedTab(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    tab: VirtualTab;
    records: ReturnType<typeof recordingLogger>['records'];
  }> {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { writeTimeoutMs: 1_000 } });
    return { harness, device, tab, records };
  }

  it('fails the write with WRITE_TIMEOUT and keeps the connection', async () => {
    const { harness, device, tab, records } = await connectedTab();

    device.pauseWrites();
    const outcome = tab.client.send('Reader', 'HELD').catch((reason: unknown) => reason);
    // Settled first: advancing the clock fires the deadline before a write not yet begun can begin.
    await harness.settle();
    await harness.advance(PAST_THE_DEADLINE_MS);

    expect(await outcome).toMatchObject({ code: SerialBrokerErrorCode.WRITE_TIMEOUT });
    expect(fieldsOfEvent(records, 'supervisor.write-stalled')).toHaveLength(1);
    await harness.advance(10_000);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(tab.statusTrail('Reader')).not.toContain(SerialBrokerStatus.Reconnecting);
  });

  it('begins nothing behind the write, and carries on once the device takes it', async () => {
    const { harness, device, tab, records } = await connectedTab();

    device.pauseWrites();
    const first = tab.client.send('Reader', 'FIRST').catch((reason: unknown) => reason);
    await harness.advance(500);
    const second = tab.client.send('Reader', 'SECOND').catch((reason: unknown) => reason);
    await harness.advance(PAST_THE_DEADLINE_MS);

    expect(await first).toMatchObject({ code: SerialBrokerErrorCode.WRITE_TIMEOUT });
    // Never begun, so it can safely be sent again - and it is not written when the device recovers.
    expect(await second).toMatchObject({
      code: SerialBrokerErrorCode.WRITE_TIMEOUT,
      context: { started: false },
    });
    expect(fieldsOfEvent(records, 'supervisor.write-stalled')).toHaveLength(1);

    device.resumeWrites();
    await harness.settle();
    await tab.client.send('Reader', 'THIRD');

    expect(device.writtenText()).toBe('FIRSTTHIRD');
    expect(tab.statusTrail('Reader')).not.toContain(SerialBrokerStatus.Reconnecting);
  });

  it('reconnects when the write it gave up on fails afterwards', async () => {
    const { harness, device, tab, records } = await connectedTab();

    device.pauseWrites();
    const outcome = tab.client.send('Reader', 'HELD').catch((reason: unknown) => reason);
    // Settled first: advancing the clock fires the deadline before a write not yet begun can begin.
    await harness.settle();
    await harness.advance(PAST_THE_DEADLINE_MS);
    expect(await outcome).toMatchObject({ code: SerialBrokerErrorCode.WRITE_TIMEOUT });
    expect(fieldsOfEvent(records, 'supervisor.write-stalled')).toHaveLength(1);

    device.faults.failWriteWith = 'NetworkError';
    device.resumeWrites();
    await harness.advance(100);

    expect(fieldsOfEvent(records, 'supervisor.reconnect')[0]?.['reason']).toBe('write-failed');
    expect(tab.statusTrail('Reader')).toContain(SerialBrokerStatus.Reconnecting);
    expect(tab.errorCodes('Reader')).toContain(SerialBrokerErrorCode.WRITE_FAILED);
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
