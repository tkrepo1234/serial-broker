import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import type { ErrorEvent } from '../../src/core/types.js';
import { ANNOUNCEMENT_CHANNEL_NAME, versionAnnouncement } from '../../src/protocol/announcement.js';
import { PROTOCOL_VERSION } from '../../src/protocol/version.js';
import { BrowserHarness, TRANSPORT_MODES } from '../harness/browser-harness.js';
import { connectedTab, READER, READER_OPTIONS, twoTabs } from '../harness/devices.js';
import { remember } from '../harness/stored-configurations.js';

/** A new `onStatusChange` listener is told the current status once. */

describe('a new status listener', () => {
  it('is told the current status once, after subscribe() has returned', async () => {
    const { harness, tab } = await connectedTab();
    const listener = vi.fn();

    tab.client.subscribe('Reader', 'onStatusChange', listener);
    expect(listener).not.toHaveBeenCalled();
    await harness.settle();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Reader',
        status: SerialBrokerStatus.Open,
        previousStatus: SerialBrokerStatus.Open,
      }),
    );
  });

  it('is not told when it unsubscribed before the status was delivered', async () => {
    const { harness, tab } = await connectedTab();
    const listener = vi.fn();

    const unsubscribe = tab.client.subscribe('Reader', 'onStatusChange', listener);
    unsubscribe();
    await harness.settle();

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a throwing listener from stopping the others', async () => {
    const { harness, tab } = await connectedTab();
    const good = vi.fn();

    tab.client.subscribe('Reader', 'onStatusChange', () => {
      throw new Error('broken listener');
    });
    tab.client.subscribe('Reader', 'onStatusChange', good);
    await harness.settle();

    expect(good).toHaveBeenCalledOnce();
  });
});

/**
 * A listener that throws is a defect in the tab it belongs to, and is reported there only.
 */

describe.each(TRANSPORT_MODES)('a listener that throws (%s)', (transport) => {
  it.each(['the tab holding the port', 'another tab'] as const)(
    'in %s is reported there only, and the others still receive',
    async (where) => {
      const { harness, device, owner, other } = await twoTabs({ transport });
      const [throwing, quiet] = where === 'another tab' ? [other, owner] : [owner, other];
      throwing.client.subscribe('Reader', 'onReceive', () => {
        throw new Error('application bug');
      });

      device.emit('x');
      await harness.settle();

      // Both tabs heard the chunk, so each had every chance to report something.
      expect(throwing.errorCodes('Reader')).toContain(SerialBrokerErrorCode.LISTENER_THREW);
      expect(quiet.errorCodes('Reader')).not.toContain(SerialBrokerErrorCode.LISTENER_THREW);
      expect(throwing.receivedText('Reader')).toBe('x');
      expect(quiet.receivedText('Reader')).toBe('x');
    },
  );
});

describe('errors that arrive while nothing listens for them', () => {
  function codes(events: readonly ErrorEvent[]): string[] {
    return events.map((event) => event.error.code);
  }

  it('reports another protocol version noticed while no configuration was set up', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await tab.client.release('Reader');

    const other = harness.bus.broadcastHub.create(ANNOUNCEMENT_CHANNEL_NAME, 'another-build');
    other.postMessage(versionAnnouncement(PROTOCOL_VERSION + 1, false));
    await harness.settle();
    await tab.setup('Reader', READER_OPTIONS);
    await harness.settle();

    expect(codes(tab.recordFor('Reader').errors)).toContain(
      SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH,
    );
  });

  it('reports a corrupt remembered configuration found by restore() in a fresh tab', async () => {
    const harness = new BrowserHarness();
    remember(harness.storage, {
      Broken: { device: { vendorId: 'no' }, serial: { baudRate: 9600 } },
      Reader: { device: READER, serial: { baudRate: 9600 } },
    });
    const tab = harness.openTab();

    await tab.client.restore();
    const errors: ErrorEvent[] = [];
    tab.client.subscribe('Reader', 'onError', (event) => errors.push(event));
    await harness.settle();

    expect(codes(errors)).toEqual([SerialBrokerErrorCode.STORAGE_CORRUPT]);
  });
});
