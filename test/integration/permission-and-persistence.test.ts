import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { storageEntryKey, storageIndexKey } from '../../src/storage/configuration-store.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { connectedTab, READER, READER_OPTIONS, readerHarness } from '../harness/devices.js';
import { remember, rememberedEntry, rememberedNames } from '../harness/stored-configurations.js';

/**
 * Remembering a device across visits.
 *
 * Two things persist and they live in different places: the browser keeps the *permission*,
 * which script can neither store nor forge, and this library keeps the *configuration*. See
 * ADR-0022.
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
    const { harness, device } = readerHarness();
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
    const { harness } = readerHarness();
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

  it('forgets a remembered configuration from a tab that never set it up', async () => {
    const { harness } = readerHarness();

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
    const { harness } = readerHarness();

    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, remember: false });
    // Nothing is stored under the name, so there is nothing to forget: a no-op, not an error.
    await expect(tab.client.release('Reader', { forget: true })).resolves.toBeUndefined();
    await harness.settle();

    expect(tab.errorCodes('Reader')).toEqual([]);
    await expect(harness.openTab().client.restore()).resolves.toEqual([]);
  });

  it('keeps working when storage is unavailable', async () => {
    const { harness } = readerHarness();
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

describe('asking for a device that is already connected', () => {
  it('leaves the working connection alone, in the tab holding the port and in another', async () => {
    const { harness, device, tab } = await connectedTab();
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);

    // Fed so that a picker opening anyway would answer rather than hang; nothing should take it.
    harness.serial.pickerQueue.push(device);
    await expect(tab.client.requestAccess('Reader')).resolves.toBe(true);
    await expect(peer.client.requestAccess('Reader')).resolves.toBe(true);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(peer.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(1);
    expect(tab.recordFor('Reader').errors).toHaveLength(0);
    // The port is open, so neither tab has anything to ask the user for. Were the picker opened
    // in one of them and not the other, the answer would say which tab holds the port (ADR-0009).
    expect(harness.serial.pickerQueue).toHaveLength(1);
  });
});

describe('remembered configurations', () => {
  it('removes an entry left behind when the same name is set up without being remembered', async () => {
    const harness = new BrowserHarness();
    remember(harness.storage, { Reader: { device: READER, serial: { baudRate: 9600 } } });
    const tab = harness.openTab();

    await tab.setup('Reader', { ...READER_OPTIONS, remember: false });
    await tab.close();

    await expect(harness.openTab().client.restore()).resolves.toEqual([]);
    expect(rememberedNames(harness.storage)).toEqual([]);
  });
});

/**
 * How remembered configurations are laid out in storage (ADR-0020).
 *
 * One key per configuration and an index of their names, carrying a storage version of their own,
 * so that a change to the message protocol costs nobody their configurations and two tabs saving at
 * the same moment cannot overwrite each other's entry.
 */

describe('the layout of remembered configurations', () => {
  it('carries a storage version, not the protocol version', () => {
    expect(storageIndexKey()).toBe('serial-broker/configurations/v1/index');
    expect(storageEntryKey('Reader')).toBe('serial-broker/configurations/v1/entry/Reader');
  });

  it('keeps each configuration under its own key, listed in the index', async () => {
    const { harness } = readerHarness();
    const tab = harness.openTab();

    await tab.setup('Reader', READER_OPTIONS);
    await tab.setup('Scale', READER_OPTIONS);

    expect(rememberedNames(harness.storage)).toEqual(['Reader', 'Scale']);
    expect(rememberedEntry(harness.storage, 'Scale')).toMatchObject({ remember: true });
  });

  it('restores what an earlier visit stored, and nothing else', async () => {
    const { harness } = readerHarness();
    remember(harness.storage, {
      Reader: { device: READER, serial: { baudRate: 9600 } },
    });

    await expect(harness.openTab().client.restore()).resolves.toEqual(['Reader']);
  });

  it('drops an index that cannot be read, and reports it once', async () => {
    const { harness } = readerHarness();
    harness.storage.poison(storageIndexKey(), '["Reader"');
    const tab = harness.openTab();

    await expect(tab.client.restore()).resolves.toEqual([]);
    await tab.setup('Reader', READER_OPTIONS);
    await harness.settle();

    expect(tab.errorCodes('Reader')).toEqual([SerialBrokerErrorCode.STORAGE_CORRUPT]);
    // Removed rather than left to be reported again on every restore.
    expect(rememberedNames(harness.storage)).toEqual(['Reader']);
  });

  it('keeps the names an index that is partly rubbish still lists', async () => {
    const { harness } = readerHarness();
    remember(harness.storage, { Reader: { device: READER, serial: { baudRate: 9600 } } });
    harness.storage.poison(storageIndexKey(), JSON.stringify(['Reader', 17, null, 'Reader']));

    await expect(harness.openTab().client.restore()).resolves.toEqual(['Reader']);
    expect(rememberedNames(harness.storage)).toEqual(['Reader']);
  });
});
