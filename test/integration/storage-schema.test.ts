import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { storageEntryKey, storageIndexKey } from '../../src/storage/configuration-store.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { remember, rememberedEntry, rememberedNames } from '../harness/stored-configurations.js';

/**
 * How remembered configurations are laid out in storage (ADR-0022, ADR-0033).
 *
 * One key per configuration and an index of their names, carrying a storage version of their own,
 * so that a change to the message protocol costs nobody their configurations and two tabs saving at
 * the same moment cannot overwrite each other's entry.
 */

function harnessWithDevice(
  options: ConstructorParameters<typeof BrowserHarness>[0] = {},
): BrowserHarness {
  const harness = new BrowserHarness(options);
  harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
  return harness;
}

describe('the layout of remembered configurations', () => {
  it('carries a storage version, not the protocol version', () => {
    expect(storageIndexKey()).toBe('serial-broker/configurations/v2/index');
    expect(storageEntryKey('Reader')).toBe('serial-broker/configurations/v2/entry/Reader');
  });

  it('keeps each configuration under its own key, listed in the index', async () => {
    const harness = harnessWithDevice();
    const tab = harness.openTab();

    await tab.setup('Reader', READER_OPTIONS);
    await tab.setup('Scale', READER_OPTIONS);

    expect(rememberedNames(harness.storage)).toEqual(['Reader', 'Scale']);
    expect(rememberedEntry(harness.storage, 'Scale')).toMatchObject({ remember: true });
  });

  it('restores what an earlier visit stored, and nothing else', async () => {
    const harness = harnessWithDevice();
    remember(harness.storage, {
      Reader: { device: READER, serial: { baudRate: 9600 } },
    });

    await expect(harness.openTab().client.restore()).resolves.toEqual(['Reader']);
  });

  it('drops an index that cannot be read, and reports it once', async () => {
    const harness = harnessWithDevice();
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
    const harness = harnessWithDevice();
    remember(harness.storage, { Reader: { device: READER, serial: { baudRate: 9600 } } });
    harness.storage.poison(storageIndexKey(), JSON.stringify(['Reader', 17, null, 'Reader']));

    await expect(harness.openTab().client.restore()).resolves.toEqual(['Reader']);
    expect(rememberedNames(harness.storage)).toEqual(['Reader']);
  });
});
