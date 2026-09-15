import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * The product claim, tested end to end: several tabs, one port.
 *
 * Every scenario runs against both transports, because the fallback must not be a path that
 * only gets exercised on someone's Android phone in production (ADR-0007).
 */
describe.each(TRANSPORT_MODES)('sharing one port across tabs (%s)', (transport) => {
  /** A harness with one granted device, and no tab open yet. */
  async function withGrantedDevice(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
  }> {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    return { harness, device };
  }

  it('opens the port once, in the first tab, and a tab that joins sees it open and hears the data', async () => {
    const { harness, device } = await withGrantedDevice();
    const first = harness.openTab();
    await first.setup('CardReader', READER_OPTIONS);
    const openedByTheFirst = first.client.getStatus('CardReader').status;

    const late = harness.openTab();
    await late.setup('CardReader', READER_OPTIONS);
    device.emit('CARD:1234');
    await harness.settle();

    expect(openedByTheFirst).toBe(SerialBrokerStatus.Open);
    // A second `open()` on a device another context holds fails with InvalidStateError in
    // every browser. One open across two tabs is the entire point of the library.
    expect(device.openCount).toBe(1);
    // The joining tab never opened anything itself: without the tab holding the port restating
    // its status, it would sit at `idle` until the next change - possibly hours.
    expect(late.client.getStatus('CardReader').status).toBe(SerialBrokerStatus.Open);
    expect(first.receivedText('CardReader')).toBe('CARD:1234');
    expect(late.receivedText('CardReader')).toBe('CARD:1234');
  });

  it('writes from a tab that does not own the port exactly once, and tells every tab who issued it', async () => {
    const { harness, device } = await withGrantedDevice();
    const owner = harness.openTab();
    await owner.setup('CardReader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('CardReader', READER_OPTIONS);

    await other.client.send('CardReader', 'STATUS?');
    await harness.settle();

    expect(device.writtenText()).toBe('STATUS?');
    expect(device.written).toHaveLength(1);
    expect(other.recordFor('CardReader').sent.map((event) => event.origin)).toEqual(['local']);
    expect(owner.recordFor('CardReader').sent.map((event) => event.origin)).toEqual(['remote']);
  });

  it('keeps two configurations on two devices apart in both directions, used from the same two tabs', async () => {
    const harness = new BrowserHarness({ transport });
    const reader = harness.serial.addDevice(READER.vendorId, READER.productId);
    const scale = harness.serial.addDevice(0x0403, 0x6001);
    harness.serial.grant(reader);
    harness.serial.grant(scale);
    const scaleOptions = {
      device: { vendorId: 0x0403, productId: 0x6001 },
      serial: { baudRate: 19200 },
      receive: { idleMs: 0 },
    };
    const first = harness.openTab();
    const second = harness.openTab();
    for (const tab of [first, second]) {
      await tab.setup('CardReader', READER_OPTIONS);
      await tab.setup('Scale', scaleOptions);
    }

    // Each tab writes to both configurations, one of which it does not hold the port of.
    await first.client.send('CardReader', 'R1');
    await second.client.send('Scale', 'S2');
    await second.client.send('CardReader', 'R2');
    await first.client.send('Scale', 'S1');
    reader.emit('from-reader');
    scale.emit('from-scale');
    await harness.settle();

    expect(reader.writtenText()).toBe('R1R2');
    expect(scale.writtenText()).toBe('S2S1');
    for (const tab of [first, second]) {
      expect(tab.receivedText('CardReader')).toBe('from-reader');
      expect(tab.receivedText('Scale')).toBe('from-scale');
      expect(tab.recordFor('CardReader').sent.map((event) => event.data.byteLength)).toEqual([
        2, 2,
      ]);
      expect(tab.recordFor('Scale').sent.map((event) => event.data.byteLength)).toEqual([2, 2]);
    }
  });
});
