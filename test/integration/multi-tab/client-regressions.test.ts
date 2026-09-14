import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import type { ErrorEvent } from '../../../src/core/types.js';
import {
  ANNOUNCEMENT_CHANNEL_NAME,
  versionAnnouncement,
} from '../../../src/protocol/announcement.js';
import { ownerLockName, PROTOCOL_VERSION } from '../../../src/protocol/version.js';
import { storageKey } from '../../../src/storage/configuration-store.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * Defects in the client found in the bug hunt of 2026-09-13, each pinned by the behaviour it broke.
 */

describe.each(TRANSPORT_MODES)('a write issued during an owner change (%s)', (transport) => {
  it.each(['closes', 'crashes'] as const)(
    'reaches the device once when the tab holding the port %s',
    async (how) => {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const first = harness.openTab();
      await first.setup('Reader', READER_OPTIONS);
      const second = harness.openTab();
      await second.setup('Reader', READER_OPTIONS);

      const busy = harness.openBusyTab();
      await busy.client.setup('Reader', READER_OPTIONS);
      await harness.settle();

      busy.hold();
      if (how === 'closes') {
        await first.close();
      } else {
        await first.kill();
      }
      await harness.advance(0);

      // The busy tab still believes the port is open with the first tab, and sends: the write
      // reaches the second tab, which holds the port now. Then the busy tab catches up, and
      // learns only afterwards that ownership moved.
      const sending = busy.client.send('Reader', 'PING');
      await harness.settle();
      busy.deliverHeld();
      await harness.settle();

      await expect(sending).resolves.toBeUndefined();
      expect(device.writtenText()).toBe('PING');
    },
  );
});

describe.each(TRANSPORT_MODES)(
  'setting a configuration up again while it is released (%s)',
  (transport) => {
    it('keeps the new session on the bus in a tab that does not hold the port', async () => {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const owner = harness.openTab();
      await owner.setup('Reader', READER_OPTIONS);
      const tab = harness.openTab();
      await tab.setup('Reader', READER_OPTIONS);

      const releasing = tab.client.release('Reader');
      await tab.setup('Reader', READER_OPTIONS);
      await releasing;
      device.emit('HELLO');
      await harness.settle();

      expect(tab.receivedText('Reader')).toBe('HELLO');
    });

    it('keeps taking writes from other tabs in a tab that holds the port alone', async () => {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      const tab = harness.openTab();
      await tab.setup('Reader', READER_OPTIONS);

      const releasing = tab.client.release('Reader');
      await tab.setup('Reader', READER_OPTIONS);
      await releasing;
      await harness.settle();
      const later = harness.openTab();
      await later.setup('Reader', READER_OPTIONS);
      await later.client.send('Reader', 'PING');

      expect(later.client.getStatus('Reader').status).toBe('open');
      expect(device.writtenText()).toBe('PING');
    });
  },
);

describe.each(TRANSPORT_MODES)('releasing and setting up in quick succession (%s)', (transport) => {
  it('leaves the configuration released when release() follows a setup() that waits', async () => {
    const harness = new BrowserHarness({ transport });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    const releasing = tab.client.release('Reader');
    const settingUp = tab.client.setup('Reader', READER_OPTIONS);
    const releasingAgain = tab.client.release('Reader');
    await Promise.all([releasing, settingUp, releasingAgain]);
    await harness.settle();

    expect(tab.client.exists('Reader')).toBe(false);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
  });

  it('keeps a listener registered on the new session when an earlier registration is removed', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const listener = vi.fn();
    const stopEarlier = tab.client.subscribe('Reader', 'onReceive', listener);
    await tab.client.release('Reader');
    await tab.setup('Reader', READER_OPTIONS);
    tab.client.subscribe('Reader', 'onReceive', listener);

    stopEarlier();
    device.emit('HELLO');
    await harness.settle();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('lets dispose() finish only once a release still in progress has closed the port', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    const releasing = tab.client.release('Reader');
    await tab.client.dispose();

    expect(device.isOpen).toBe(false);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    await releasing;
  });
});

describe.each(TRANSPORT_MODES)(
  'a listener that releases on the status it hears (%s)',
  (transport) => {
    it('does not leave the other tabs with the status it superseded', async () => {
      const harness = new BrowserHarness({ transport });
      // Not granted yet: the port opens only when the user picks the device, after both tabs are set up.
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      const owner = harness.openTab();
      await owner.setup('Reader', READER_OPTIONS);
      const other = harness.openTab();
      await other.setup('Reader', READER_OPTIONS);

      // The tab holding the port gives it up as soon as it opens.
      owner.client.subscribe('Reader', 'onStatusChange', (event) => {
        if (event.status === 'open') {
          void owner.client.release('Reader');
        }
      });
      harness.serial.pickerQueue.push(device);
      await owner.client.requestAccess('Reader');
      await harness.advance(0);
      await harness.advance(0);

      // Once told the port was given up, the other tab must not hear the port is open from the
      // tab that gave it up - only from itself, when it opens the port in turn.
      const trail = other.statusTrail('Reader');
      const releasedAt = trail.lastIndexOf('reconnecting');
      expect(releasedAt).toBeGreaterThanOrEqual(0);
      expect(trail.slice(releasedAt + 1, releasedAt + 2)).not.toEqual(['open']);
    });
  },
);

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
    harness.storage.poison(
      storageKey(),
      JSON.stringify({
        Broken: { device: { vendorId: 'no' }, serial: { baudRate: 9600 } },
        Reader: { device: READER, serial: { baudRate: 9600 } },
      }),
    );
    const tab = harness.openTab();

    await tab.client.restore();
    const errors: ErrorEvent[] = [];
    tab.client.subscribe('Reader', 'onError', (event) => errors.push(event));
    await harness.settle();

    expect(codes(errors)).toEqual([SerialBrokerErrorCode.STORAGE_CORRUPT]);
  });
});
