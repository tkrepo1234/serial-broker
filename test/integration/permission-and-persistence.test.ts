import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/**
 * Remembering a device across visits.
 *
 * Two things persist and they live in different places: the browser keeps the *permission*,
 * which script can neither store nor forge, and this library keeps the *configuration*. See
 * ADR-0036.
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

  it('lets a tab that does not hold the port ask for it, and the tab holding it connects', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);
    expect(owner.client.getStatus('Reader').status).toBe(SerialBrokerStatus.AwaitingPermission);

    // The permission is the origin's: granted in this tab, the tab holding the port opens it.
    harness.serial.pickerQueue.push(device);
    await expect(peer.client.requestAccess('Reader')).resolves.toBe(true);
    await harness.settle();

    expect(owner.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(peer.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.isOpen).toBe(true);
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
      timestamp: harness.clock.now(),
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

  it('restores a persisted configuration in a new tab, with no prompt', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    // Would be taken by a picker, had one been shown.
    harness.serial.pickerQueue.push(device);

    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    await first.close();

    const reloaded = harness.openTab();
    const restored = await reloaded.client.restore();
    await harness.settle();

    // The permission is the browser's and survives the reload; `getPorts()` returns the
    // device with no gesture and no picker.
    expect(restored).toEqual(['Reader']);
    expect(reloaded.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(harness.serial.pickerQueue).toEqual([device]);
  });

  it('keeps the browser permission when a configuration is released, and revokes it only when asked to', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // Releasing a configuration must not cost the user their grant, or every release would
    // mean another click the next time.
    await tab.client.release('Reader');
    await tab.setup('Reader', READER_OPTIONS);
    const afterRelease = tab.client.getStatus('Reader').status;
    await tab.client.release('Reader', { forgetDevice: true });
    await tab.setup('Reader', READER_OPTIONS);

    expect(afterRelease).toBe(SerialBrokerStatus.Open);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.AwaitingPermission);
  });

  it('keeps a released configuration remembered, and forgets it only when asked to', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    // Disconnecting is not deleting. With one tab open - a screen on a production line, which is
    // the ordinary case - the old rule took the configuration away with the release, and the next
    // visit had nothing to reconnect to.
    await tab.client.release('Reader');
    await tab.close();

    const reloaded = harness.openTab();
    await expect(reloaded.client.restore()).resolves.toEqual(['Reader']);
    await reloaded.close();

    const forgetting = harness.openTab();
    await forgetting.setup('Reader', READER_OPTIONS);
    await forgetting.client.release('Reader', { forget: true });
    await forgetting.close();

    await expect(harness.openTab().client.restore()).resolves.toEqual([]);
  });

  it('forgets a remembered configuration from a tab that never set it up', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    await first.client.release('Reader');
    await first.close();

    // A page that lists what the browser remembers - the debugging surface does - must be able to
    // drop an entry without connecting to it first: what is remembered belongs to the origin, not
    // to whichever tab happens to run it. Disconnecting has nothing to do here, and says so by
    // doing nothing.
    const listing = harness.openTab();
    await expect(listing.client.release('Reader', { forget: true })).resolves.toBeUndefined();
    await listing.close();

    await expect(harness.openTab().client.restore()).resolves.toEqual([]);
  });

  it('forgets nothing for a configuration that was never remembered, and reports nothing', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, remember: false });
    // Nothing is stored under the name, so there is nothing to forget: a no-op, not an error.
    await expect(tab.client.release('Reader', { forget: true })).resolves.toBeUndefined();
    await harness.settle();

    expect(tab.errorCodes('Reader')).toEqual([]);
    await expect(harness.openTab().client.restore()).resolves.toEqual([]);
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
