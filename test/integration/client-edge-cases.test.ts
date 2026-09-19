import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { DEFAULT_CONNECTION_SETTINGS } from '../../src/core/defaults.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { BrowserHarness, type VirtualTab } from '../harness/browser-harness.js';
import { connectedTab, READER, READER_OPTIONS } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

describe('unusable environments', () => {
  // Without an exclusive lock there is no way to guarantee one owner, and guessing would be
  // worse than refusing; without Web Serial there is no device at all.
  it.each([
    ['Web Serial', { serial: {} as never }, SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE],
    ['Web Locks', { locks: {} as never }, SerialBrokerErrorCode.WEB_LOCKS_UNAVAILABLE],
  ] as const)('refuses to set up a configuration without %s', async (_label, missing, code) => {
    const harness = new BrowserHarness();
    const client = new SerialBrokerClient({ ...harness.createEnvironment('probe'), ...missing });

    await expect(client.setup('Reader', READER_OPTIONS)).rejects.toMatchObject({ code });
  });
});

describe('a disposed client', () => {
  /** A tab whose client has been disposed, as a page that has torn the library down leaves it. */
  async function disposedTab(): Promise<VirtualTab> {
    const tab = new BrowserHarness().openTab();
    await tab.client.dispose();
    return tab;
  }

  it('refuses further setup', async () => {
    const tab = await disposedTab();

    await expect(tab.client.setup('Reader', READER_OPTIONS)).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_RELEASED,
    });
  });

  it('refuses to restore', async () => {
    const tab = await disposedTab();

    await expect(tab.client.restore()).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_RELEASED,
    });
  });

  it('can be disposed twice', async () => {
    const tab = await disposedTab();

    await expect(tab.client.dispose()).resolves.toBeUndefined();
  });
});

describe('a device that cannot be forgotten', () => {
  it('still releases the configuration', async () => {
    const { harness, tab } = await connectedTab();

    const forget = vi.fn(() => Promise.reject(new Error('forget() is not implemented here')));
    const ports = await harness.serial.forContext(tab.id).getPorts();
    for (const port of ports) {
      Object.assign(port, { forget });
    }

    // `forget()` is newer than the rest of Web Serial and absent in older Chromium. Failing
    // to revoke a permission is not a reason to fail the release.
    await expect(tab.client.release('Reader', { forgetDevice: true })).resolves.toBeUndefined();
    expect(forget).toHaveBeenCalledOnce();
    expect(tab.client.exists('Reader')).toBe(false);
  });

  it('still releases it where the browser has no forget() at all', async () => {
    const { logger, records } = recordingLogger();
    const { harness, tab } = await connectedTab({ logger });
    for (const port of await harness.serial.forContext(tab.id).getPorts()) {
      Object.assign(port, { forget: undefined });
    }

    await expect(tab.client.release('Reader', { forgetDevice: true })).resolves.toBeUndefined();

    // Said as what it is, not as a call that failed.
    expect(fieldsOfEvent(records, 'client.forget-unsupported')).toHaveLength(1);
    expect(fieldsOfEvent(records, 'client.forget-failed')).toEqual([]);
  });

  it('still releases it where forget() never answers', async () => {
    const { logger, records } = recordingLogger();
    const { harness, tab } = await connectedTab({ logger });
    for (const port of await harness.serial.forContext(tab.id).getPorts()) {
      Object.assign(port, { forget: () => new Promise<never>(() => undefined) });
    }

    let isReleased = false;
    const released = tab.client.release('Reader', { forgetDevice: true }).then(() => {
      isReleased = true;
    });
    await harness.settle();
    expect(isReleased).toBe(false);

    // Bounded like every call into Web Serial: a release that waited for ever would keep every
    // later `setup()` of the name waiting with it.
    await harness.clock.advance(DEFAULT_CONNECTION_SETTINGS.openTimeoutMs);
    await released;

    expect(fieldsOfEvent(records, 'client.forget-failed')).toEqual([
      expect.objectContaining({ reason: expect.stringContaining('Timed out') as unknown }),
    ]);
  });
});

describe('a released configuration', () => {
  it('refuses a send after release', async () => {
    const { tab } = await connectedTab();

    await tab.client.release('Reader');

    await expect(tab.client.send('Reader', 'x')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.UNKNOWN_CONFIGURATION,
    });
  });
});

describe('disposing a client', () => {
  it('logs a cleanup step that failed instead of dropping it', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const environment = harness.createEnvironment('page');
    const serial = environment.serial;
    const client = new SerialBrokerClient({
      ...environment,
      serial: {
        getPorts: () => serial.getPorts(),
        requestPort: (options) => serial.requestPort(options),
        addEventListener: (type, listener) => {
          serial.addEventListener(type, listener);
        },
        removeEventListener: () => {
          throw new Error('the platform refused');
        },
      },
    });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    await client.setup('Reader', READER_OPTIONS);

    await client.dispose();

    expect(fieldsOfEvent(records, 'client.dispose-failed')).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining('the platform refused') as unknown,
      }),
    ]);
  });
});
