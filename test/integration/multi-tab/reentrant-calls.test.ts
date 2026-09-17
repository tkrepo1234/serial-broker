import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { persistenceLockName } from '../../../src/storage/persistence-hold.js';
import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER_OPTIONS, readerHarness } from '../../harness/devices.js';
import { outcomeOf } from '../../harness/outcomes.js';

const SCALE_OPTIONS = {
  device: { vendorId: 0x0403, productId: 0x6001 },
  serial: { baudRate: 19_200 },
};

/**
 * Application code runs inside the library: every listener is called from the middle of a state
 * change, and may call the API again from there (docs/guidelines/defensive-programming.md). Whatever
 * it calls, the state change it interrupted has to end as it would have without it.
 */
describe('calling release again while a release is closing the port', () => {
  it.each([
    ['release()', (client: VirtualTab['client']) => client.release('Reader')],
    ['releaseAll()', (client: VirtualTab['client']) => client.releaseAll()],
  ])('resolves %s only once the port is closed', async (_name, releaseAgain) => {
    const { harness, device } = readerHarness();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    // A write the device holds keeps the port open while the release drains it.
    device.pauseWrites();
    void outcomeOf(tab.client.send('Reader', 'PING'));
    await harness.settle();

    const first = tab.client.release('Reader');
    let isSecondDone = false;
    const second = releaseAgain(tab.client).then(() => {
      isSecondDone = true;
    });
    await harness.settle();
    const wasDoneWhileOpen = isSecondDone;
    const wasOpen = device.isOpen;
    device.resumeWrites();
    await Promise.all([first, second]);

    expect(wasOpen).toBe(true);
    expect(wasDoneWhileOpen).toBe(false);
    expect(device.isOpen).toBe(false);
    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
  });
});

describe.each(TRANSPORT_MODES)(
  'an onSend listener that releases the configuration (%s)',
  (transport) => {
    for (const issuer of ['the tab holding the port', 'another tab'] as const) {
      for (const call of ['release', 'dispose'] as const) {
        it(`does not fail the write it was told reached the device, issued by ${issuer}, when the listener calls ${call}()`, async () => {
          const { harness, device } = readerHarness({ transport });
          const owner = harness.openTab();
          await owner.setup('Reader', READER_OPTIONS);
          const participant = harness.openTab();
          await participant.setup('Reader', READER_OPTIONS);
          const tab = issuer === 'another tab' ? participant : owner;
          tab.client.subscribe('Reader', 'onSend', () => {
            void (call === 'release' ? tab.client.release('Reader') : tab.client.dispose());
          });

          const outcome = outcomeOf(tab.client.send('Reader', 'PING'));
          await harness.settle();

          expect(device.writtenText()).toBe('PING');
          expect(await outcome).toBe('resolved');
        });
      }
    }
  },
);

describe('a listener that releases a configuration while it is being set up', () => {
  it('leaves no hold behind on the remembered configuration', async () => {
    const { harness } = readerHarness();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    // Storage that fails reports to every configuration - the one being set up is already one.
    tab.client.subscribe('Reader', 'onError', (event) => {
      if (event.error.code === SerialBrokerErrorCode.STORAGE_UNAVAILABLE) {
        for (const name of tab.client.names()) {
          void tab.client.release(name);
        }
      }
    });

    harness.storage.isUnavailable = true;
    await tab.client.setup('Scale', SCALE_OPTIONS);
    await harness.settle();
    harness.storage.isUnavailable = false;
    await harness.settle();

    expect(tab.client.names()).toEqual([]);
    expect(harness.locks.holdersOf(persistenceLockName('Scale'))).toEqual([]);
    expect(harness.locks.holdersOf(persistenceLockName('Reader'))).toEqual([]);
    expect(harness.locks.holderOf(ownerLockName('Scale'))).toBeUndefined();
  });
});

describe.each(TRANSPORT_MODES)('a diagnostics watcher calling the observer (%s)', (transport) => {
  async function watchedDevice() {
    const { harness, device } = readerHarness({ transport });
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const observer = harness.openObserver();
    return { harness, device, observer };
  }

  it('stops another watcher it removes from hearing the event being delivered', async () => {
    const { harness, device, observer } = await watchedDevice();
    const heard: string[] = [];
    let stopSecond: () => void = () => undefined;
    observer.watch('Reader', () => {
      heard.push('first');
      stopSecond();
    });
    stopSecond = observer.watch('Reader', () => heard.push('second'));
    await harness.settle();

    device.emit('x');
    await harness.settle();

    expect(heard).toEqual(['first']);
  });

  it('delivers nothing more once a watcher closes the observer', async () => {
    const { harness, device, observer } = await watchedDevice();
    const heard: string[] = [];
    observer.watch('Reader', () => {
      heard.push('first');
      observer.close();
    });
    observer.watch('Reader', () => heard.push('second'));
    await harness.settle();

    device.emit('x');
    await harness.settle();

    expect(heard).toEqual(['first']);
  });
});
