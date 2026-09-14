import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { persistenceLockName } from '../../../src/storage/persistence-hold.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * A remembered configuration is one entry for the whole origin, and it is forgotten only when no
 * tab runs it with `persist: true` any more (ADR-0027).
 */

describe.each(TRANSPORT_MODES)(
  'a remembered configuration run in several tabs (%s)',
  (transport) => {
    function harnessWithDevice(): BrowserHarness {
      const harness = new BrowserHarness({ transport });
      const device = harness.serial.addDevice(READER.vendorId, READER.productId);
      harness.serial.grant(device);
      return harness;
    }

    /** What a tab opened now - a reload - restores. */
    async function restoredByANewTab(harness: BrowserHarness): Promise<readonly string[]> {
      const reloaded = harness.openTab();
      const names = await reloaded.client.restore();
      await reloaded.close();
      return names;
    }

    it('stays remembered when one tab releases it while another still runs it', async () => {
      const harness = harnessWithDevice();
      const first = harness.openTab();
      await first.setup('Reader', READER_OPTIONS);
      const second = harness.openTab();
      await second.setup('Reader', READER_OPTIONS);

      await first.client.release('Reader');
      await harness.settle();

      expect(await restoredByANewTab(harness)).toEqual(['Reader']);
    });

    it('is forgotten once the last tab running it releases it', async () => {
      const harness = harnessWithDevice();
      const first = harness.openTab();
      await first.setup('Reader', READER_OPTIONS);
      const second = harness.openTab();
      await second.setup('Reader', READER_OPTIONS);

      await first.client.release('Reader');
      await second.client.release('Reader');
      await harness.settle();

      expect(await restoredByANewTab(harness)).toEqual([]);
    });

    it('is forgotten by a release when the other tab running it was closed or crashed', async () => {
      const harness = harnessWithDevice();
      const first = harness.openTab();
      await first.setup('Reader', READER_OPTIONS);
      const closed = harness.openTab();
      await closed.setup('Reader', READER_OPTIONS);
      const crashed = harness.openTab();
      await crashed.setup('Reader', READER_OPTIONS);

      // Neither of them releases anything: a closed tab's entry stays, as the next visit needs it,
      // and a closed or crashed tab no longer runs the configuration.
      await closed.close();
      await crashed.kill();
      expect(harness.locks.holdersOf(persistenceLockName('Reader'))).toEqual([first.id]);

      await first.client.release('Reader');
      await harness.settle();

      expect(await restoredByANewTab(harness)).toEqual([]);
    });

    it('stays remembered when the last tab running it is closed instead of releasing it', async () => {
      const harness = harnessWithDevice();
      const first = harness.openTab();
      await first.setup('Reader', READER_OPTIONS);
      const second = harness.openTab();
      await second.setup('Reader', READER_OPTIONS);

      await first.close();
      await second.kill();

      expect(await restoredByANewTab(harness)).toEqual(['Reader']);
    });

    it('stays remembered when releaseAll() in one tab releases it', async () => {
      const harness = harnessWithDevice();
      const first = harness.openTab();
      await first.setup('Reader', READER_OPTIONS);
      await first.setup('Scale', { ...READER_OPTIONS, serial: { baudRate: 19_200 } });
      const second = harness.openTab();
      await second.setup('Reader', READER_OPTIONS);

      await first.client.releaseAll();
      await harness.settle();

      expect(await restoredByANewTab(harness)).toEqual(['Reader']);
    });

    it('stays remembered when a tab running it releases it and forgets the device', async () => {
      const harness = harnessWithDevice();
      const first = harness.openTab();
      await first.setup('Reader', READER_OPTIONS);
      const second = harness.openTab();
      await second.setup('Reader', READER_OPTIONS);

      await first.client.release('Reader', { forgetDevice: true });
      await harness.settle();

      // The permission is gone for every tab of the origin; the configuration the other tab runs is
      // not, and a later visit waits for permission with it.
      expect(await restoredByANewTab(harness)).toEqual(['Reader']);
    });

    it('is not forgotten by a tab that runs the same name without persist', async () => {
      const harness = harnessWithDevice();
      const remembering = harness.openTab();
      await remembering.setup('Reader', READER_OPTIONS);
      const transient = harness.openTab();
      await transient.setup('Reader', { ...READER_OPTIONS, persist: false });
      await harness.settle();
      expect(await restoredByANewTab(harness)).toEqual(['Reader']);

      await transient.client.release('Reader');
      await harness.settle();
      expect(await restoredByANewTab(harness)).toEqual(['Reader']);

      await remembering.client.release('Reader');
      await harness.settle();
      expect(await restoredByANewTab(harness)).toEqual([]);
    });

    it('is remembered after a tab sets it up while another tab forgets it', async () => {
      const harness = harnessWithDevice();
      const releasing = harness.openTab();
      await releasing.setup('Reader', READER_OPTIONS);

      // In the same turn: the release checks whether anyone runs the configuration while the new
      // tab has saved the entry but does not hold it yet.
      const joining = harness.openTab();
      const released = releasing.client.release('Reader');
      const setUp = joining.client.setup('Reader', READER_OPTIONS);
      await Promise.all([released, setUp]);
      await harness.settle();

      expect(joining.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
      expect(await restoredByANewTab(harness)).toEqual(['Reader']);
    });
  },
);
