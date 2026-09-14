import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import {
  DISCARDED_STORAGE_KEYS,
  storageEntryKey,
  storageIndexKey,
} from '../../src/storage/configuration-store.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';
import { remember, rememberedEntry, rememberedNames } from '../harness/stored-configurations.js';

/**
 * How remembered configurations are laid out in storage (ADR-0022, ADR-0033).
 *
 * One key per configuration and an index of their names, carrying a storage version of their own,
 * so that a change to the message protocol costs nobody their configurations and two tabs saving at
 * the same moment cannot overwrite each other's entry.
 */

const PROTOCOL_4_KEY = 'serial-broker/v4/configurations';
const VERSION_1_KEY = 'serial-broker/configurations/v1';

function stored(...names: string[]): string {
  return JSON.stringify(
    Object.fromEntries(names.map((name) => [name, { device: READER, serial: { baudRate: 9600 } }])),
  );
}

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
    expect(DISCARDED_STORAGE_KEYS).toContain(PROTOCOL_4_KEY);
  });

  it('keeps each configuration under its own key, listed in the index', async () => {
    const harness = harnessWithDevice();
    const tab = harness.openTab();

    await tab.setup('Reader', READER_OPTIONS);
    await tab.setup('Scale', READER_OPTIONS);

    expect(rememberedNames(harness.storage)).toEqual(['Reader', 'Scale']);
    expect(rememberedEntry(harness.storage, 'Scale')).toMatchObject({ persist: true });
  });

  it('restores what an earlier visit stored, and nothing else', async () => {
    const harness = harnessWithDevice();
    remember(harness.storage, {
      Reader: { device: READER, serial: { baudRate: 9600 } },
    });

    await expect(harness.openTab().client.restore()).resolves.toEqual(['Reader']);
  });

  it('removes what an earlier version stored, without reading it', async () => {
    const { logger, records } = recordingLogger();
    const harness = harnessWithDevice({ logger });
    harness.storage.poison(VERSION_1_KEY, stored('Reader'));
    harness.storage.poison(PROTOCOL_4_KEY, stored('Older'));

    // Nothing is carried over before 1.0: the formats are not read, and their keys do not linger.
    await expect(harness.openTab().client.restore()).resolves.toEqual([]);
    for (const key of [VERSION_1_KEY, ...DISCARDED_STORAGE_KEYS]) {
      expect(harness.storage.getItem(key)).toBeNull();
    }
    expect(fieldsOfEvent(records, 'storage.old-format-discarded')).toEqual([
      expect.objectContaining({ keys: expect.stringContaining(VERSION_1_KEY) as string }),
    ]);
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

  it('forgets a name whose entry is gone, and reports it', async () => {
    const harness = harnessWithDevice();
    remember(harness.storage, { Reader: { device: READER, serial: { baudRate: 9600 } } });
    harness.storage.poison(storageIndexKey(), JSON.stringify(['Reader', 'Vanished']));
    const tab = harness.openTab();

    await expect(tab.client.restore()).resolves.toEqual(['Reader']);
    // Setting up the restored name is how this tab starts listening; the error it missed follows.
    await tab.setup('Reader', READER_OPTIONS);
    await harness.settle();

    expect(tab.errorCodes('Reader')).toEqual([SerialBrokerErrorCode.STORAGE_CORRUPT]);
    expect(rememberedNames(harness.storage)).toEqual(['Reader']);
  });

  it('leaves the other entries alone when one tab saves while another one does', async () => {
    const harness = harnessWithDevice();
    const first = harness.openTab();
    const second = harness.openTab();

    // Neither call sees the other's entry: with one key for all of them, whichever wrote last
    // would have carried its own stale copy of the other over the newer one.
    await Promise.all([
      first.client.setup('Reader', READER_OPTIONS),
      second.client.setup('Scale', { ...READER_OPTIONS, serial: { baudRate: 19_200 } }),
    ]);
    await harness.settle();

    expect(rememberedNames(harness.storage).sort()).toEqual(['Reader', 'Scale']);
    expect(rememberedEntry(harness.storage, 'Scale')).toMatchObject({
      serial: expect.objectContaining({ baudRate: 19_200 }) as object,
    });
  });
});
