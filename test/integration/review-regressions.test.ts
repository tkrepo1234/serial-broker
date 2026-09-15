import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import { brokerChannelName, PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';
import { rememberedNames } from '../harness/stored-configurations.js';

/**
 * Defects found in the review of 2026-09-13, each pinned by the behaviour it broke.
 */

async function connectedTab(): Promise<{
  harness: BrowserHarness;
  device: ReturnType<BrowserHarness['serial']['addDevice']>;
  tab: ReturnType<BrowserHarness['openTab']>;
}> {
  const harness = new BrowserHarness();
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const tab = harness.openTab();
  await tab.setup('Reader', READER_OPTIONS);
  return { harness, device, tab };
}

describe('releasing a configuration', () => {
  it('reports released as its last status', async () => {
    const { tab } = await connectedTab();

    await tab.client.release('Reader');

    expect(tab.statusTrail('Reader').at(-1)).toBe(SerialBrokerStatus.Released);
  });

  it('keeps remembering a configuration set up again while the port was still closing', async () => {
    const { harness, tab } = await connectedTab();

    const releasing = tab.client.release('Reader');
    await tab.client.setup('Reader', READER_OPTIONS);
    await releasing;
    await harness.settle();

    expect(rememberedNames(harness.storage)).toEqual(['Reader']);
  });
});

describe('asking for a device that is already connected', () => {
  it('leaves the working connection alone', async () => {
    const { harness, device, tab } = await connectedTab();

    harness.serial.pickerQueue.push(device);
    await expect(tab.client.requestAccess('Reader')).resolves.toBe(true);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(1);
    expect(tab.recordFor('Reader').errors).toHaveLength(0);
  });
});

describe('options and names', () => {
  it('rejects null instead of treating it as not set', () => {
    expect(() =>
      normalizeConfiguration('Reader', {
        ...READER_OPTIONS,
        serial: { baudRate: 9600, dataBits: null },
      }),
    ).toThrow(
      expect.objectContaining({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
        context: expect.objectContaining({ argumentName: 'options.serial.dataBits' }) as unknown,
      }),
    );
  });

  it('remembers a configuration named __proto__', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();
    await tab.setup('__proto__', READER_OPTIONS);

    const later = harness.openTab();

    await expect(later.client.restore()).resolves.toContain('__proto__');
  });
});

describe('setting a configuration up again', () => {
  it('conflicts when only the buffer size differs, since the port opens with it', async () => {
    const { tab } = await connectedTab();

    await expect(
      tab.client.setup('Reader', {
        ...READER_OPTIONS,
        serial: { baudRate: 9600, bufferSize: 4096 },
      }),
    ).rejects.toMatchObject({ code: SerialBrokerErrorCode.CONFIGURATION_CONFLICT });
  });
});

describe('a killed tab', () => {
  it('runs none of its timers any more', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'NetworkError';
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await harness.advance(1_000);
    const before = fieldsOfEvent(records, 'supervisor.reconnect').length;
    expect(before).toBeGreaterThan(0);

    await tab.kill();
    await harness.advance(60_000);

    expect(fieldsOfEvent(records, 'supervisor.reconnect')).toHaveLength(before);
  });
});

describe('a mixed deployment', () => {
  it('is reported once per foreign protocol version, not once per message', async () => {
    const harness = new BrowserHarness({ transport: 'broadcastchannel' });
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const foreign = { v: PROTOCOL_VERSION + 1, from: 'old-tab', to: 'all', type: 'hello' };

    harness.bus.broadcastHub.injectForeign(brokerChannelName(), foreign);
    harness.bus.broadcastHub.injectForeign(brokerChannelName(), foreign);
    await harness.settle();

    const mismatches = tab
      .recordFor('Reader')
      .errors.filter(
        (event) => event.error.code === SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH,
      );
    expect(mismatches).toHaveLength(1);
  });
});

describe('handing the port over by releasing it', () => {
  it('lets the next tab open the port while the releasing tab stays open', async () => {
    const { harness, device, tab: owner } = await connectedTab();
    const other = harness.openTab();
    await other.setup('Reader', READER_OPTIONS);

    // The releasing tab lives on, so nothing but its own close() can free the device.
    await owner.client.release('Reader');
    await harness.settle();

    expect(other.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(2);
  });
});
