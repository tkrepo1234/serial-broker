import { describe, expect, it } from 'vitest';

import { LEGACY_STORAGE_KEYS, storageKey } from '../../src/storage/configuration-store.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

/**
 * Remembered configurations outlive changes to the message protocol (ADR-0022).
 */

const PROTOCOL_4_KEY = 'serial-broker/v4/configurations';
const PROTOCOL_3_KEY = 'serial-broker/v3/configurations';

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

describe('remembered configurations across versions of serial-broker', () => {
  it('are kept under a key that carries a storage version, not the protocol version', () => {
    expect(storageKey()).toBe('serial-broker/configurations/v1');
    expect(LEGACY_STORAGE_KEYS).toContain(PROTOCOL_4_KEY);
  });

  it('are restored from the protocol-versioned key an earlier build used, and moved', async () => {
    const { logger, records } = recordingLogger();
    const harness = harnessWithDevice({ logger });
    harness.storage.poison(PROTOCOL_4_KEY, stored('Reader'));

    const restored = await harness.openTab().client.restore();

    expect(restored).toEqual(['Reader']);
    expect(harness.storage.getItem(PROTOCOL_4_KEY)).toBeNull();
    expect(harness.storage.getItem(storageKey())).toContain('"Reader"');
    expect(fieldsOfEvent(records, 'storage.migrated')).toEqual([
      expect.objectContaining({ from: PROTOCOL_4_KEY }),
    ]);
  });

  it("keep the newest earlier build's configurations and remove every old key", async () => {
    const harness = harnessWithDevice();
    harness.storage.poison(PROTOCOL_3_KEY, stored('Older'));
    harness.storage.poison(PROTOCOL_4_KEY, stored('Reader'));

    const restored = await harness.openTab().client.restore();

    expect(restored).toEqual(['Reader']);
    for (const key of LEGACY_STORAGE_KEYS) {
      expect(harness.storage.getItem(key)).toBeNull();
    }
  });

  it('are not moved again once the current key exists', async () => {
    const harness = harnessWithDevice();
    harness.storage.poison(storageKey(), stored('Reader'));
    // As a tab of an older build that is still open would write it.
    harness.storage.poison(PROTOCOL_4_KEY, stored('Older'));

    const restored = await harness.openTab().client.restore();

    expect(restored).toEqual(['Reader']);
    expect(harness.storage.getItem(PROTOCOL_4_KEY)).toBe(stored('Older'));
  });
});
