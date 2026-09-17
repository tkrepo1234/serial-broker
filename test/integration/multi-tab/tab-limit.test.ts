import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER_OPTIONS, readerHarness } from '../../harness/devices.js';
import type { TransportMode } from '../../harness/fake-bus.js';

/**
 * Limiting how many tabs use a configuration at once (ADR-0025).
 */

async function harnessWithDevice(transport: TransportMode) {
  const { harness, device } = readerHarness({ transport });
  return { harness, device };
}

describe.each(TRANSPORT_MODES)('tabs beyond the tab limit (%s)', (transport) => {
  it('wait, receive nothing, and join when a tab releases the configuration', async () => {
    const { harness, device } = await harnessWithDevice(transport);
    const first = harness.openTab();
    await first.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const second = harness.openTab();
    await second.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });

    expect(second.client.getStatus('Reader').status).toBe('queued');
    device.emit('FIRST ONLY');
    await harness.settle();
    expect(first.receivedText('Reader')).toBe('FIRST ONLY');
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

  it('refuse requestAccess() with PERMISSION_REQUIRED while they wait', async () => {
    const { harness } = await harnessWithDevice(transport);
    const first = harness.openTab();
    await first.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const second = harness.openTab();
    await second.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    await harness.settle();
    expect(second.client.getStatus('Reader').status).toBe('queued');

    // A queued tab does not take part, so it may not ask for the origin's permission (ADR-0036).
    await expect(second.client.requestAccess('Reader')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.PERMISSION_REQUIRED,
      context: { status: 'queued' },
    });
  });
});

describe.each(TRANSPORT_MODES)('a tab running a different tab limit (%s)', (transport) => {
  it('reports the conflict in that tab, withdraws, and leaves the tab holding the port alone', async () => {
    const { harness, device } = await harnessWithDevice(transport);
    const holder = harness.openTab();
    await holder.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const other = harness.openTab();
    await other.setup('Reader', { ...READER_OPTIONS, maxTabs: 2 });
    await harness.settle();

    expect(other.client.getStatus('Reader').status).toBe('failed');
    expect(other.errorCodes('Reader')).toContain(SerialBrokerErrorCode.CONFIGURATION_CONFLICT);
    expect(other.recordFor('Reader').errors[0]?.error.context).toMatchObject({
      maxTabs: 2,
      holdingTabMaxTabs: 1,
    });
    // The other tabs believe errors only from the tab holding the port (ADR-0025).
    expect(holder.errorCodes('Reader')).not.toContain(SerialBrokerErrorCode.CONFIGURATION_CONFLICT);

    device.emit('HOLDER');
    await harness.settle();
    expect(holder.client.getStatus('Reader').status).toBe('open');
    expect(holder.receivedText('Reader')).toBe('HOLDER');
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

  it('refuses requestAccess() with PERMISSION_REQUIRED once it has withdrawn', async () => {
    const { harness } = await harnessWithDevice(transport);
    const holder = harness.openTab();
    await holder.setup('Reader', { ...READER_OPTIONS, maxTabs: 1 });
    const other = harness.openTab();
    await other.setup('Reader', { ...READER_OPTIONS, maxTabs: 2 });
    await harness.settle();
    expect(other.client.getStatus('Reader').status).toBe('failed');

    await expect(other.client.requestAccess('Reader')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.PERMISSION_REQUIRED,
    });
  });
});

/**
 * The range and default of `maxTabs` are held against the documentation in documentation.test.ts,
 * and remembering it - no limit included - in configuration-store.test.ts.
 */
describe('the maxTabs option', () => {
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
});
