import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../src/core/types.js';
import { BrowserHarness } from '../harness/browser-harness.js';
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
 * write and the library has to accept whatever the user granted. See ADR-0036.
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
});
