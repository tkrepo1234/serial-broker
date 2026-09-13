import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { storageKey } from '../../src/storage/configuration-store.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/**
 * Remembering a device across visits.
 *
 * Two things persist and they live in different places: the browser keeps the *permission*,
 * which script can neither store nor forge, and this library keeps the *configuration*. See
 * ADR-0009.
 */
describe('permission and persistence', () => {
  it('waits for permission when no granted device matches', async () => {
    const harness = new BrowserHarness();
    harness.serial.addDevice(READER.vendorId, READER.productId);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // Not an error: the user has simply never granted this device, and the browser will not
    // show a picker outside a user gesture. The application has to ask.
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.AwaitingPermission);
  });

  it('connects after the user picks the device', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    harness.serial.pickerQueue.push(device);
    const granted = await tab.client.requestAccess('Reader');
    await harness.settle();

    expect(granted).toBe(true);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('reports a dismissed picker as a decision, not a failure', async () => {
    const harness = new BrowserHarness();
    harness.serial.addDevice(READER.vendorId, READER.productId);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // The picker queue is empty, so the user dismisses it. Throwing here would force every
    // caller to write a try/catch around the ordinary case.
    await expect(tab.client.requestAccess('Reader')).resolves.toBe(false);
  });

  it('refuses a device whose IDs do not match the configuration', async () => {
    const harness = new BrowserHarness();
    const wrongDevice = harness.serial.addDevice(0x0403, 0x6001);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    // A browser applies the filters and would not offer this device. The check behind them
    // still has to hold, should one offer it anyway.
    harness.serial.ignoresFilters = true;
    harness.serial.pickerQueue.push(wrongDevice);

    await expect(tab.client.requestAccess('Reader')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.DEVICE_MISMATCH,
    });
  });

  it('offers only the configured device in the picker', async () => {
    const harness = new BrowserHarness();
    const wrongDevice = harness.serial.addDevice(0x0403, 0x6001);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    harness.serial.pickerQueue.push(wrongDevice);

    // The picker filters by the configured USB IDs, so the user can only dismiss it.
    await expect(tab.client.requestAccess('Reader')).resolves.toBe(false);
  });

  it('connects with no prompt on a later visit', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    // Would be taken by a picker, had one been shown.
    harness.serial.pickerQueue.push(device);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // The permission is the browser's and survives the reload; `getPorts()` returns the
    // device with no gesture and no picker.
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(harness.serial.pickerQueue).toEqual([device]);
  });

  it('restores a persisted configuration in a new tab without being told about it', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    await first.close();

    const reloaded = harness.openTab();
    const restored = await reloaded.client.restore();
    await harness.settle();

    expect(restored).toEqual(['Reader']);
    expect(reloaded.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('keeps the browser permission when a configuration is released', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await tab.client.release('Reader');

    // Releasing a configuration must not cost the user their grant, or every release would
    // mean another click the next time.
    await tab.setup('Reader', READER_OPTIONS);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('revokes the browser permission only when asked to', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await tab.client.release('Reader', { forgetDevice: true });

    await tab.setup('Reader', READER_OPTIONS);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.AwaitingPermission);
  });

  it('forgets a released configuration so it is not restored later', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await tab.client.release('Reader');
    await tab.close();

    const reloaded = harness.openTab();
    await expect(reloaded.client.restore()).resolves.toEqual([]);
  });

  it('does not persist a configuration marked as transient', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, persist: false });
    await tab.close();

    const reloaded = harness.openTab();
    await expect(reloaded.client.restore()).resolves.toEqual([]);
  });

  it('discards a corrupt stored configuration instead of failing to start', async () => {
    const harness = new BrowserHarness();
    harness.storage.poison(storageKey(), '{ this is not json');

    const tab = harness.openTab();

    await expect(tab.client.restore()).resolves.toEqual([]);
    expect(harness.storage.getItem(storageKey())).toBeNull();
  });

  it('discards only the invalid entry when others are still usable', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    harness.storage.poison(
      storageKey(),
      JSON.stringify({
        Broken: { device: { vendorId: 'not-a-number', productId: 1 }, serial: { baudRate: 9600 } },
        Reader: { device: READER, serial: { baudRate: 9600 } },
      }),
    );

    const tab = harness.openTab();
    const restored = await tab.client.restore();

    // One bad entry must not cost the application the others.
    expect(restored).toEqual(['Reader']);
  });

  it('keeps working when storage is unavailable', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    harness.storage.isUnavailable = true;

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // A private window or a sandboxed iframe loses persistence, not the device.
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);

    // Read from the snapshot rather than from recorded events: the storage write happens
    // inside `setup()`, before any application code could have subscribed. This is exactly
    // what `lastErrorCode` is for - it makes a failure that predates the first listener
    // visible instead of lost.
    expect(tab.client.getStatus('Reader').lastErrorCode).toBe(
      SerialBrokerErrorCode.STORAGE_UNAVAILABLE,
    );
  });
});
