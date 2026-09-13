import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { brokerChannelName, PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/**
 * Posts something a well-behaved tab would never send.
 *
 * Uses the fallback transport, where each context validates for itself. With the broker,
 * these messages are filtered at the worker and never reach a tab at all - which is a
 * property of ADR-0008's partitioning, not an accident.
 */
function injectRaw(harness: BrowserHarness, raw: unknown): void {
  harness.bus.broadcastHub.injectForeign(brokerChannelName(), raw);
}

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

  it('rejects an invalid name before doing anything with it', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();

    await expect(tab.client.send('', 'x')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
    });
    expect(() => tab.client.exists(42 as never)).toThrow();
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

    const ports = await harness.serial.forContext(tab.id).getPorts();
    for (const port of ports) {
      Object.assign(port, {
        forget: () => Promise.reject(new Error('forget() is not implemented here')),
      });
    }

    // `forget()` is newer than the rest of Web Serial and absent in older Chromium. Failing
    // to revoke a permission is not a reason to fail the release.
    await expect(tab.client.release('Reader', { forgetDevice: true })).resolves.toBeUndefined();
    expect(tab.client.exists('Reader')).toBe(false);
  });
});

describe('hostile traffic on the shared bus', () => {
  const fallback = { transport: 'broadcastchannel' } as const;

  it('reports a peer running an incompatible protocol version', async () => {
    const harness = new BrowserHarness(fallback);
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // A tab left open across a deployment that changed the protocol. Both groups partition
    // and both report it, rather than misreading each other's messages (ADR-0008).
    injectRaw(harness, {
      v: PROTOCOL_VERSION + 1,
      from: 'old-tab',
      to: 'all',
      type: 'attach',
      configName: 'Reader',
    });
    await harness.settle();

    const mismatch = tab
      .recordFor('Reader')
      .errors.find((event) => event.error.code === SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH);
    expect(mismatch?.error.remediation).toContain('Reload all tabs');
  });

  it('drops a malformed message without disturbing the connection', async () => {
    const harness = new BrowserHarness(fallback);
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    injectRaw(harness, { v: PROTOCOL_VERSION, from: 'noise', to: 'all', type: 'nonsense' });
    await harness.settle();
    device.emit('still working');
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(tab.receivedText('Reader')).toBe('still working');
  });

  it('ignores a status message for a configuration it does not have', async () => {
    const harness = new BrowserHarness(fallback);
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    expect(() => {
      injectRaw(harness, {
        v: PROTOCOL_VERSION,
        from: 'peer',
        to: 'all',
        type: 'status',
        configName: 'SomethingElse',
        status: 'failed',
        timestamp: 1,
      });
    }).not.toThrow();
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });
});

describe('a configuration released while events are in flight', () => {
  it('stops delivering to its listeners', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    await tab.client.release('Reader');
    device.emit('after release');
    await harness.settle();

    expect(tab.recordFor('Reader').received).toHaveLength(0);
  });

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
