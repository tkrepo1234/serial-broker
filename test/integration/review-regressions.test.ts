import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { normalizeConfiguration } from '../../src/core/validation.js';
import { storageKey } from '../../src/protocol/version.js';
import { BrowserHarness } from '../harness/browser-harness.js';

const READER = { vendorId: 0x1a86, productId: 0x7523 };
const OPTIONS = { device: READER, serial: { baudRate: 9600 } };

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
  await tab.setup('Reader', OPTIONS);
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
    await tab.client.setup('Reader', OPTIONS);
    await releasing;
    await harness.settle();

    expect(harness.storage.getItem(storageKey())).toContain('"Reader"');
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

describe('reconnecting after a connection that held', () => {
  it('retries at once only once, then backs off as from a fresh start', async () => {
    const delays: unknown[] = [];
    const harness = new BrowserHarness({
      logger: {
        log: (_level, _message, fields) => {
          if (fields.event === 'supervisor.reconnect') {
            delays.push(fields['delayMs']);
          }
        },
      },
    });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    await harness.openTab().setup('Reader', OPTIONS);
    // Longer than stableAfterMs, so the attempt count starts over when the connection breaks.
    await harness.advance(6_000);

    device.faults.failOpenWith = 'NetworkError';
    device.breakStream();
    await harness.settle();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await harness.clock.advanceToNextTimer();
      await harness.settle();
    }

    // Before the fix this was [0, 0, 250, 500]: two immediate retries in a row.
    expect(delays.slice(0, 4)).toEqual([0, 250, 500, 1000]);
  });
});

describe('options and names', () => {
  it('rejects null instead of treating it as not set', () => {
    expect(() =>
      normalizeConfiguration('Reader', { ...OPTIONS, serial: { baudRate: 9600, dataBits: null } }),
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
    await tab.setup('__proto__', OPTIONS);

    const later = harness.openTab();

    await expect(later.client.restore()).resolves.toContain('__proto__');
  });
});
