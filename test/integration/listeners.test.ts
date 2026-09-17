import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { TRANSPORT_MODES } from '../harness/browser-harness.js';
import { READER_OPTIONS, readerHarness, twoTabs } from '../harness/devices.js';

/** A new `onStatusChange` listener is told the current status once. */

async function openTab() {
  const { harness } = readerHarness();
  const tab = harness.openTab();
  await tab.client.setup('Reader', READER_OPTIONS);
  await harness.settle();
  return { harness, tab };
}

describe('a new status listener', () => {
  it('is told the current status once, after subscribe() has returned', async () => {
    const { harness, tab } = await openTab();
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
    const { harness, tab } = await openTab();
    const listener = vi.fn();

    const unsubscribe = tab.client.subscribe('Reader', 'onStatusChange', listener);
    unsubscribe();
    await harness.settle();

    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps a throwing listener from stopping the others', async () => {
    const { harness, tab } = await openTab();
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
