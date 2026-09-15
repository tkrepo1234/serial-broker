import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import type { SerialBrokerOptions } from '../../src/core/types.js';
import { BrowserHarness } from '../harness/browser-harness.js';
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
