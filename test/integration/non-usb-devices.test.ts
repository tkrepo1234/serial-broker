import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../src/core/types.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import { matchesDevice, toRequestOptions } from '../../src/owner/port-matcher.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

const ANY_DEVICE = {
  device: { any: true },
  serial: { baudRate: 9600 },
  // Each chunk as it is read, as in READER_OPTIONS.
  receive: { idleMs: 0 },
} as const;

/**
 * Ports that report no USB identity at all.
 *
 * A built-in RS-232 interface on an industrial PC, a virtual COM port pair, a Bluetooth
 * serial profile: `getInfo()` tells you nothing about any of them, so there is no filter to
 * write and the library has to accept whatever the user granted. See ADR-0016.
 */
describe('a device with no USB identity', () => {
  it('sends and receives like any other device', async () => {
    const harness = new BrowserHarness();
    const port = harness.serial.addNonUsbPort();
    harness.serial.grant(port);
    const tab = harness.openTab();
    await tab.setup('LocalPort', ANY_DEVICE);

    await tab.client.send('LocalPort', 'AT');
    port.emit('OK');
    await harness.settle();

    expect(port.writtenText()).toBe('AT');
    expect(tab.receivedText('LocalPort')).toBe('OK');
  });

  it('shares the port across tabs and fails over', async () => {
    const harness = new BrowserHarness();
    const port = harness.serial.addNonUsbPort();
    harness.serial.grant(port);

    const owner = harness.openTab();
    await owner.setup('LocalPort', ANY_DEVICE);
    const peer = harness.openTab();
    await peer.setup('LocalPort', ANY_DEVICE);

    await owner.kill();
    port.emit('AFTER');
    await harness.settle();

    // Nothing about coordination depends on how the device is identified.
    expect(peer.client.getStatus('LocalPort').status).toBe(SerialBrokerStatus.Open);
    expect(peer.receivedText('LocalPort')).toBe('AFTER');
    expect(port.openCount).toBe(2);
  });

  it('reports no vendor or product ID in its status', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addNonUsbPort());
    const tab = harness.openTab();
    await tab.setup('LocalPort', ANY_DEVICE);

    const status = tab.client.getStatus('LocalPort');
    expect(status.vendorId).toBeUndefined();
    expect(status.productId).toBeUndefined();
  });

  it('is restored from storage like any other configuration', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addNonUsbPort());

    const first = harness.openTab();
    await first.setup('LocalPort', ANY_DEVICE);
    await first.close();

    const reloaded = harness.openTab();
    await expect(reloaded.client.restore()).resolves.toEqual(['LocalPort']);
    await harness.settle();
    expect(reloaded.client.getStatus('LocalPort').status).toBe(SerialBrokerStatus.Open);
  });

  it('warns rather than guessing when several ports could match', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const first = harness.serial.addNonUsbPort();
    const second = harness.serial.addNonUsbPort();
    harness.serial.grant(first);
    harness.serial.grant(second);

    const tab = harness.openTab();
    await tab.setup('LocalPort', ANY_DEVICE);

    // The honest outcome: an `any` filter cannot tell two ports apart, so it takes the first
    // and says so. Documented as a known limitation rather than hidden.
    expect(tab.client.getStatus('LocalPort').status).toBe(SerialBrokerStatus.Open);
    expect(first.isOpen).toBe(true);
    expect(second.isOpen).toBe(false);
    expect(fieldsOfEvent(records, 'matcher.ambiguous')).toEqual([
      expect.objectContaining({ configName: 'LocalPort', matchCount: 2 }),
    ]);
  });

  it('shows the picker unfiltered, so a non-USB port is offered at all', () => {
    const configuration = normalizeConfiguration('LocalPort', ANY_DEVICE);

    // An empty `filters` array would hide exactly the ports this exists to find.
    expect(toRequestOptions(configuration)).toEqual({});
  });
});

describe('the device filter', () => {
  it('matches a port that reports nothing at all', () => {
    const configuration = normalizeConfiguration('LocalPort', ANY_DEVICE);

    expect(matchesDevice({ getInfo: () => ({}) } as unknown as SerialPort, configuration)).toBe(
      true,
    );
  });

  it('matches only the configured device when it names one', () => {
    const configuration = normalizeConfiguration('Reader', READER_OPTIONS);

    expect(
      matchesDevice(
        {
          getInfo: () => ({ usbVendorId: READER.vendorId, usbProductId: READER.productId }),
        } as unknown as SerialPort,
        configuration,
      ),
    ).toBe(true);
    expect(matchesDevice({ getInfo: () => ({}) } as unknown as SerialPort, configuration)).toBe(
      false,
    );
  });

  it('treats two wildcard configurations as compatible with each other', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addNonUsbPort());
    const tab = harness.openTab();

    await tab.client.setup('LocalPort', ANY_DEVICE);
    await expect(tab.client.setup('LocalPort', ANY_DEVICE)).resolves.toBeUndefined();
  });
});
