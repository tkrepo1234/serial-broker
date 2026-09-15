import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import type { SerialBrokerOptions } from '../../src/core/types.js';
import { BrowserHarness, TRANSPORT_MODES } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/**
 * `connection.autoReconnect: false`: the application reconnects, the library does not (ADR-0010).
 * Setting a configuration that gave up up again is how it does.
 */

const MANUAL: SerialBrokerOptions = { ...READER_OPTIONS, connection: { autoReconnect: false } };

async function connectedTab() {
  const harness = new BrowserHarness();
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const tab = harness.openTab();
  await tab.setup('Reader', MANUAL);
  await harness.settle();
  return { harness, device, tab };
}

describe('a configuration that does not reconnect by itself', () => {
  it('ends in failed when the connection is lost, and stays there when the device comes back', async () => {
    const { harness, device, tab } = await connectedTab();
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);

    harness.serial.unplug(device);
    await harness.advance(60_000);
    const whileAway = tab.client.getStatus('Reader').status;
    harness.serial.plug(device);
    await harness.advance(60_000);

    expect(whileAway).toBe(SerialBrokerStatus.Failed);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);
    expect(tab.statusTrail('Reader')).not.toContain(SerialBrokerStatus.Reconnecting);
    expect(tab.errorCodes('Reader')).toEqual([SerialBrokerErrorCode.DEVICE_DISCONNECTED]);
  });

  it('connects again when the application sets it up again, and leaves a working one alone', async () => {
    const { harness, device, tab } = await connectedTab();

    harness.serial.unplug(device);
    await harness.settle();
    harness.serial.plug(device);
    await harness.settle();
    await tab.setup('Reader', MANUAL);
    await harness.settle();
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);

    const trail = tab.statusTrail('Reader').length;
    await tab.client.setup('Reader', MANUAL);
    await harness.settle();
    expect(tab.statusTrail('Reader')).toHaveLength(trail);
  });

  it('still connects to a device that was never there when it is plugged in: that is no reconnect', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    harness.serial.unplug(device);
    const tab = harness.openTab();

    await tab.setup('Reader', MANUAL);
    await harness.settle();
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.AwaitingPermission);
    harness.serial.plug(device);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });
});

/** Tabs of one configuration, each connected to the device; the first holds the port. */
async function connectedTabs(
  count: number,
  options: SerialBrokerOptions,
  transport: (typeof TRANSPORT_MODES)[number],
) {
  const harness = new BrowserHarness({ transport });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const tabs = [];
  for (let index = 0; index < count; index += 1) {
    const tab = harness.openTab();
    await tab.setup('Reader', options);
    tabs.push(tab);
  }
  await harness.settle();
  return { harness, device, tabs };
}

describe.each(TRANSPORT_MODES)('a failed configuration handed over (%s)', (transport) => {
  describe.each(['closes', 'crashes'] as const)('when the tab holding the port %s', (ending) => {
    it.each([2, 3])('stays failed in every tab of %i, and connects nothing', async (count) => {
      const { harness, device, tabs } = await connectedTabs(count, MANUAL, transport);
      const [holder, ...others] = tabs;
      harness.serial.unplug(device);
      await harness.settle();
      harness.serial.plug(device);
      await harness.advance(60_000);
      expect(others.map((tab) => tab.client.getStatus('Reader').status)).toEqual(
        others.map(() => SerialBrokerStatus.Failed),
      );
      const trails = others.map((tab) => tab.statusTrail('Reader').length);
      const opened = device.openCount;

      await (ending === 'closes' ? holder?.close() : holder?.kill());
      await harness.advance(60_000);

      // After a loss the operator decides: no tab reconnects because another went away.
      expect(device.openCount).toBe(opened);
      expect(device.isOpen).toBe(false);
      for (const [index, tab] of others.entries()) {
        expect(tab.client.getStatus('Reader')).toMatchObject({
          status: SerialBrokerStatus.Failed,
          lastErrorCode: SerialBrokerErrorCode.DEVICE_DISCONNECTED,
        });
        expect(tab.statusTrail('Reader').slice(trails[index])).toEqual([]);
      }
    });
  });

  it('connects when a tab that does not hold the port sets it up again after the handover', async () => {
    const { harness, device, tabs } = await connectedTabs(3, MANUAL, transport);
    const [holder, next, last] = tabs;
    harness.serial.unplug(device);
    await harness.settle();
    harness.serial.plug(device);
    await harness.settle();
    await holder?.kill();
    await harness.advance(60_000);
    expect(last?.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);

    await last?.client.setup('Reader', MANUAL);
    await harness.settle();

    expect(next?.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(last?.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.isOpen).toBe(true);
  });

  it('tells a tab that joins after the handover that it failed', async () => {
    const { harness, device, tabs } = await connectedTabs(2, MANUAL, transport);
    harness.serial.unplug(device);
    await harness.settle();
    harness.serial.plug(device);
    await tabs[0]?.close();
    await harness.settle();

    const joined = harness.openTab();
    await joined.setup('Reader', MANUAL);
    await harness.settle();

    expect(joined.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);
    expect(device.isOpen).toBe(false);
  });

  it('still reconnects through a handover with autoReconnect on', async () => {
    const options: SerialBrokerOptions = { ...READER_OPTIONS, connection: { maxAttempts: 1 } };
    const { harness, device, tabs } = await connectedTabs(2, options, transport);
    harness.serial.unplug(device);
    await harness.advance(60_000);
    expect(tabs[1]?.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);
    // Back without the event that would revive the tab holding the port by itself.
    device.isAttached = true;

    await tabs[0]?.close();
    await harness.settle();

    expect(tabs[1]?.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.isOpen).toBe(true);
  });
});

describe.each(TRANSPORT_MODES)('whether an error says the library recovers (%s)', (transport) => {
  it.each([
    ['off', MANUAL, false],
    ['on', READER_OPTIONS, true],
  ] as const)(
    'follows autoReconnect %s for a lost connection, in every tab',
    async (_label, options, recovering) => {
      const { harness, device, tabs } = await connectedTabs(2, options, transport);

      harness.serial.unplug(device);
      await harness.settle();

      for (const tab of tabs) {
        const errors = tab.recordFor('Reader').errors.map((event) => event.error);
        expect(errors.map((error) => error.code)).toEqual([
          SerialBrokerErrorCode.DEVICE_DISCONNECTED,
        ]);
        expect(errors.map((error) => error.isRetryable)).toEqual([recovering]);
      }
    },
  );

  it('is false for a failed attempt with autoReconnect off, in every tab', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    // Another program holds the device: `OPEN_FAILED`, which the library retries when it may.
    device.faults.failOpenWith = 'InvalidStateError';
    const holder = harness.openTab();
    await holder.setup('Reader', MANUAL);
    const other = harness.openTab();
    await other.setup('Reader', MANUAL);
    await harness.settle();

    // Set up again from the other tab: the attempt fails once more, and every tab hears it.
    await other.client.setup('Reader', MANUAL);
    await harness.settle();

    expect(holder.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);
    for (const tab of [holder, other]) {
      const errors = tab.recordFor('Reader').errors.map((event) => event.error);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.every((error) => error.code === SerialBrokerErrorCode.OPEN_FAILED)).toBe(true);
      expect(errors.every((error) => !error.isRetryable)).toBe(true);
    }
  });
});
