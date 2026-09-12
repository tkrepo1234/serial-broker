import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import { matchesDevice, toRequestOptions } from '../../src/owner/port-matcher.js';
import { BrowserHarness } from '../harness/browser-harness.js';

const ANY_DEVICE = { device: { any: true }, serial: { baudRate: 9600 } } as const;
const USB_DEVICE = {
  device: { vendorId: 0x1a86, productId: 0x7523 },
  serial: { baudRate: 9600 },
};

/**
 * Ports that report no USB identity at all.
 *
 * A built-in RS-232 interface on an industrial PC, a virtual COM port pair, a Bluetooth
 * serial profile: `getInfo()` tells you nothing about any of them, so there is no filter to
 * write and the library has to accept whatever the user granted. See ADR-0016.
 */
describe('a device with no USB identity', () => {
  it('connects through an "any" configuration', async () => {
    const harness = new BrowserHarness();
    const port = harness.serial.addNonUsbPort();
    harness.serial.grant(port);

    const tab = harness.openTab();
    await tab.setup('LocalPort', ANY_DEVICE);

    // With a USB filter this is unreachable: `getInfo()` reports nothing to match against, so
    // the port would stay invisible and the status would sit at `awaiting-permission` forever.
    expect(tab.client.getStatus('LocalPort').status).toBe(SerialBrokerStatus.Open);
  });

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
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addNonUsbPort());
    harness.serial.grant(harness.serial.addNonUsbPort());

    const tab = harness.openTab();
    await tab.setup('LocalPort', ANY_DEVICE);

    // The honest outcome: an `any` filter cannot tell two ports apart, so it takes the first
    // and says so. Documented as a known limitation rather than hidden.
    expect(tab.client.getStatus('LocalPort').status).toBe(SerialBrokerStatus.Open);
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
    const configuration = normalizeConfiguration('Reader', USB_DEVICE);

    expect(
      matchesDevice(
        { getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x7523 }) } as unknown as SerialPort,
        configuration,
      ),
    ).toBe(true);
    expect(matchesDevice({ getInfo: () => ({}) } as unknown as SerialPort, configuration)).toBe(
      false,
    );
  });

  it('rejects a filter that is both specific and a wildcard', () => {
    // Either reading would be a guess about which device to open, and that is not a guess
    // worth making.
    expect(() =>
      normalizeConfiguration('Mixed', {
        device: { any: true, vendorId: 0x1a86, productId: 0x7523 },
        serial: { baudRate: 9600 },
      }),
    ).toThrow(expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT }));
  });

  it('rejects `any` set to anything other than true', () => {
    expect(() =>
      normalizeConfiguration('Odd', { device: { any: 'yes' }, serial: { baudRate: 9600 } }),
    ).toThrow(expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT }));
  });

  it('still requires IDs when none of them says any', () => {
    expect(() =>
      normalizeConfiguration('Reader', {
        device: { vendorId: 0x1a86 },
        serial: { baudRate: 9600 },
      }),
    ).toThrow(expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT }));
  });

  it('treats two wildcard configurations as compatible with each other', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addNonUsbPort());
    const tab = harness.openTab();

    await tab.client.setup('LocalPort', ANY_DEVICE);
    await expect(tab.client.setup('LocalPort', ANY_DEVICE)).resolves.toBeUndefined();
  });

  it('refuses to turn a USB configuration into a wildcard one', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(0x1a86, 0x7523));
    const tab = harness.openTab();
    await tab.client.setup('Reader', USB_DEVICE);

    // One of the two would open a port the other never asked for.
    await expect(tab.client.setup('Reader', ANY_DEVICE)).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_CONFLICT,
    });
  });
});
