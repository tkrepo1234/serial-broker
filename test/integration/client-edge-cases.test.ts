import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { DEFAULT_CONNECTION_SETTINGS } from '../../src/core/defaults.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

describe('unusable environments', () => {
  it('refuses to set up a configuration without Web Serial', async () => {
    const harness = new BrowserHarness();
    const client = new SerialBrokerClient({
      ...harness.createEnvironment('probe'),
      serial: {} as never,
    });

    await expect(client.setup('Reader', READER_OPTIONS)).rejects.toMatchObject({
      code: SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
    });
  });

  it('refuses to set up a configuration without Web Locks', async () => {
    const harness = new BrowserHarness();
    const client = new SerialBrokerClient({
      ...harness.createEnvironment('probe'),
      locks: {} as never,
    });

    // Without an exclusive lock there is no way to guarantee one owner, and guessing would be
    // worse than refusing.
    await expect(client.setup('Reader', READER_OPTIONS)).rejects.toMatchObject({
      code: SerialBrokerErrorCode.WEB_LOCKS_UNAVAILABLE,
    });
  });
});

describe('a disposed client', () => {
  it('refuses further setup', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();
    await tab.client.dispose();

    await expect(tab.client.setup('Reader', READER_OPTIONS)).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_RELEASED,
    });
  });

  it('refuses to restore', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();
    await tab.client.dispose();

    await expect(tab.client.restore()).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_RELEASED,
    });
  });

  it('can be disposed twice', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();

    await tab.client.dispose();
    await expect(tab.client.dispose()).resolves.toBeUndefined();
  });
});

describe('argument validation at the boundary', () => {
  it('rejects a listener that is not a function', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);

    expect(() => tab.client.subscribe('Reader', 'onReceive', 'not a function' as never)).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('rejects an event name it does not know, rather than registering a listener never called', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);

    expect(() => tab.client.subscribe('Reader', 'onData' as never, vi.fn())).toThrow(
      expect.objectContaining({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
        context: expect.objectContaining({ argumentName: 'event' }) as unknown,
      }),
    );
    expect(tab.client.diagnostics()?.configurations[0]?.listeners).toEqual({
      onReceive: 0,
      onSend: 0,
      onError: 0,
      onStatusChange: 0,
    });
  });

  it('rejects an invalid name before doing anything with it', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();

    await expect(tab.client.send('', 'x')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
    });
    expect(() => tab.client.exists(42 as never)).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('ignores unsubscribing from a configuration that is not set up', () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();

    expect(() => {
      tab.client.unsubscribe('Nothing', 'onReceive', vi.fn());
    }).not.toThrow();
  });
});

describe('a device that cannot be forgotten', () => {
  it('still releases the configuration', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

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
    const harness = new BrowserHarness({ logger });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
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
    const harness = new BrowserHarness({ logger });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
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
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    await tab.client.release('Reader');

    await expect(tab.client.send('Reader', 'x')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.UNKNOWN_CONFIGURATION,
    });
  });
});
