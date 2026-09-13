import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { normalizeConfiguration } from '../../../src/core/validation.js';
import { storageKey } from '../../../src/storage/configuration-store.js';
import { BrowserHarness, type VirtualTab } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import type { TransportMode } from '../../harness/fake-bus.js';

/**
 * Limiting how many tabs use a configuration at once (ADR-0025).
 */

const TRANSPORTS: readonly TransportMode[] = ['sharedworker', 'broadcastchannel'];

function codes(tab: VirtualTab): string[] {
  return tab.recordFor('Reader').errors.map((event) => event.error.code);
}

async function harnessWithDevice(transport: TransportMode) {
  const harness = new BrowserHarness({ transport });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  return { harness, device };
}

describe.each(TRANSPORTS)('tabs beyond the tab limit (%s)', (transport) => {
  it('wait, receive nothing, and join when a tab releases the configuration', async () => {
    const { harness, device } = await harnessWithDevice(transport);
    const first = harness.openTab();
    await first.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const second = harness.openTab();
    await second.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });

    expect(second.client.getStatus('Reader').status).toBe('queued');
    device.emit('FIRST ONLY');
    await harness.settle();
    expect(second.receivedText('Reader')).toBe('');

    await first.client.release('Reader');
    await harness.advance(0);
    device.emit('SECOND');
    await harness.settle();

    // Queued before anything was recorded; then admitted, and on to the port.
    expect(second.statusTrail('Reader')).toEqual(['idle', 'connecting', 'open']);
    expect(second.client.getStatus('Reader').status).toBe('open');
    expect(second.receivedText('Reader')).toBe('SECOND');
  });

  it('join when a tab holding a place crashes', async () => {
    const { harness } = await harnessWithDevice(transport);
    const first = harness.openTab();
    await first.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const second = harness.openTab();
    await second.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });

    await first.kill();
    await harness.advance(0);

    expect(second.client.getStatus('Reader').status).toBe('open');
  });

  it('count the tab holding the port, and wait for a place a participant gives up', async () => {
    const { harness, device } = await harnessWithDevice(transport);
    const options = { ...READER_OPTIONS, maxTabs: 2 };
    const owner = harness.openTab();
    await owner.setup('Reader', options);
    const participant = harness.openTab();
    await participant.setup('Reader', options);
    const third = harness.openTab();
    await third.setup('Reader', options);

    expect(third.client.getStatus('Reader').status).toBe('queued');

    await participant.client.release('Reader');
    await harness.advance(0);
    device.emit('THIRD');
    await harness.settle();

    expect(third.client.getStatus('Reader').status).toBe('open');
    expect(third.receivedText('Reader')).toBe('THIRD');
    expect(owner.client.getStatus('Reader').status).toBe('open');
  });

  it('fail their writes at the deadline while they wait', async () => {
    const { harness } = await harnessWithDevice(transport);
    const first = harness.openTab();
    await first.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const second = harness.openTab();
    await second.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });

    const writing = second.client.send('Reader', 'PING').catch((error: unknown) => error);
    // The default write deadline: READER_OPTIONS leaves it alone.
    await harness.advance(5_000);

    expect(await writing).toMatchObject({ code: SerialBrokerErrorCode.WRITE_TIMEOUT });
  });
});

describe.each(TRANSPORTS)('a tab running a different tab limit (%s)', (transport) => {
  it('reports the conflict to every tab, withdraws, and leaves the tab holding the port alone', async () => {
    const { harness, device } = await harnessWithDevice(transport);
    const holder = harness.openTab();
    await holder.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const other = harness.openTab();
    await other.setup('Reader', { ...READER_OPTIONS, maxTabs: 2 });
    await harness.settle();

    expect(other.client.getStatus('Reader').status).toBe('failed');
    expect(codes(other)).toContain(SerialBrokerErrorCode.CONFIGURATION_CONFLICT);
    expect(other.recordFor('Reader').errors[0]?.error.context).toMatchObject({
      maxTabs: 2,
      holdingTabMaxTabs: 1,
    });
    expect(codes(holder)).toContain(SerialBrokerErrorCode.CONFIGURATION_CONFLICT);

    device.emit('HOLDER');
    await harness.settle();
    expect(holder.client.getStatus('Reader').status).toBe('open');
    expect(other.receivedText('Reader')).toBe('');
  });

  it('refuses a write with the conflict at once, instead of letting it wait for its deadline', async () => {
    const { harness, device } = await harnessWithDevice(transport);
    const holder = harness.openTab();
    await holder.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const other = harness.openTab();
    await other.setup('Reader', { ...READER_OPTIONS, maxTabs: 2 });

    const writing = other.client.send('Reader', 'PING').catch((error: unknown) => error);
    await harness.settle();

    expect(await Promise.race([writing, Promise.resolve('still waiting')])).toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_CONFLICT,
    });
    expect(device.writtenText()).toBe('');
  });
});

describe('the maxTabs option', () => {
  const options = (maxTabs: unknown) => ({ ...READER_OPTIONS, maxTabs });

  it('accepts 1 to 100 and Infinity, and defaults to no limit', () => {
    expect(normalizeConfiguration('Reader', READER_OPTIONS).maxTabs).toBe(Number.POSITIVE_INFINITY);
    expect(normalizeConfiguration('Reader', options(1)).maxTabs).toBe(1);
    expect(normalizeConfiguration('Reader', options(100)).maxTabs).toBe(100);
    for (const invalid of [0, 1.5, 101, -1, Number.NaN, '2', null]) {
      expect(() => normalizeConfiguration('Reader', options(invalid))).toThrow(
        expect.objectContaining({
          code: SerialBrokerErrorCode.INVALID_ARGUMENT,
          context: expect.objectContaining({ argumentName: 'options.maxTabs' }) as unknown,
        }),
      );
    }
  });

  it('cannot be changed by a second setup() in the same tab', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, maxTabs: 2 });

    await expect(
      tab.client.setup('Reader', { ...READER_OPTIONS, maxTabs: 3 }),
    ).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_CONFLICT,
    });
  });

  it('is remembered across a reload, and no limit is stored as no limit', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();
    await tab.setup('Limited', { ...READER_OPTIONS, maxTabs: 2 });
    await tab.setup('Unlimited', READER_OPTIONS);
    await tab.close();

    expect(harness.storage.getItem(storageKey())).not.toContain('null');
    const reloaded = harness.openTab();
    await reloaded.client.restore();

    expect(
      reloaded.client.diagnostics()?.configurations.map((c) => [c.name, c.settings.maxTabs]),
    ).toEqual([
      ['Limited', 2],
      ['Unlimited', Number.POSITIVE_INFINITY],
    ]);
  });
});
