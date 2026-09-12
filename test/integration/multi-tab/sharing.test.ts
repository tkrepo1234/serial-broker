import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../../src/core/types.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';

const CARD_READER = { vendorId: 0x1a86, productId: 0x7523 };
const OPTIONS = { device: CARD_READER, serial: { baudRate: 9600 } };

/**
 * The product claim, tested end to end: several tabs, one port.
 *
 * Every scenario runs against both transports, because the fallback must not be a path that
 * only gets exercised on someone's Android phone in production (ADR-0007).
 */
describe.each(TRANSPORT_MODES)('sharing one port across tabs (%s)', (transport) => {
  /** A harness with one granted device and one tab already connected to it. */
  async function withOpenPort(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
  }> {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(CARD_READER.vendorId, CARD_READER.productId);
    harness.serial.grant(device);
    return { harness, device };
  }

  it('opens the port in the first tab that sets the configuration up', async () => {
    const { harness, device } = await withOpenPort();

    const tab = harness.openTab();
    await tab.setup('CardReader', OPTIONS);

    expect(tab.client.getStatus('CardReader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(1);
  });

  it('does not open the port a second time when another tab joins', async () => {
    const { harness, device } = await withOpenPort();

    const first = harness.openTab();
    await first.setup('CardReader', OPTIONS);
    const second = harness.openTab();
    await second.setup('CardReader', OPTIONS);

    // A second `open()` on a device another context holds fails with InvalidStateError in
    // every browser. One open across two tabs is the entire point of the library.
    expect(device.openCount).toBe(1);
  });

  it('delivers received data to every tab', async () => {
    const { harness, device } = await withOpenPort();
    const first = harness.openTab();
    await first.setup('CardReader', OPTIONS);
    const second = harness.openTab();
    await second.setup('CardReader', OPTIONS);

    device.emit('CARD:1234');
    await harness.settle();

    expect(first.receivedText('CardReader')).toBe('CARD:1234');
    expect(second.receivedText('CardReader')).toBe('CARD:1234');
  });

  it('writes from a tab that does not own the port, exactly once', async () => {
    const { harness, device } = await withOpenPort();
    const owner = harness.openTab();
    await owner.setup('CardReader', OPTIONS);
    const other = harness.openTab();
    await other.setup('CardReader', OPTIONS);

    await other.client.send('CardReader', 'STATUS?');
    await harness.settle();

    expect(device.writtenText()).toBe('STATUS?');
    expect(device.written).toHaveLength(1);
  });

  it('tells every tab about a write, and who issued it', async () => {
    const { harness } = await withOpenPort();
    const owner = harness.openTab();
    await owner.setup('CardReader', OPTIONS);
    const other = harness.openTab();
    await other.setup('CardReader', OPTIONS);

    await other.client.send('CardReader', 'PING');
    await harness.settle();

    expect(other.recordFor('CardReader').sent.map((event) => event.origin)).toEqual(['local']);
    expect(owner.recordFor('CardReader').sent.map((event) => event.origin)).toEqual(['remote']);
  });

  it('reports the current status to a tab that joins an already-open configuration', async () => {
    const { harness } = await withOpenPort();
    const first = harness.openTab();
    await first.setup('CardReader', OPTIONS);

    const late = harness.openTab();
    await late.setup('CardReader', OPTIONS);
    await harness.settle();

    // The joining tab never opened anything itself, so without the broker asking the owner to
    // restate its status this tab would sit at `idle` until the next change - possibly hours.
    expect(late.client.getStatus('CardReader').status).toBe(SerialBrokerStatus.Open);
  });

  it('keeps two configurations on two devices independent', async () => {
    const harness = new BrowserHarness({ transport });
    const reader = harness.serial.addDevice(0x1a86, 0x7523);
    const scale = harness.serial.addDevice(0x0403, 0x6001);
    harness.serial.grant(reader);
    harness.serial.grant(scale);

    const tab = harness.openTab();
    await tab.setup('CardReader', OPTIONS);
    await tab.setup('Scale', {
      device: { vendorId: 0x0403, productId: 0x6001 },
      serial: { baudRate: 19200 },
    });

    await tab.client.send('CardReader', 'A');
    await tab.client.send('Scale', 'B');
    reader.emit('from-reader');
    scale.emit('from-scale');
    await harness.settle();

    expect(reader.writtenText()).toBe('A');
    expect(scale.writtenText()).toBe('B');
    expect(tab.receivedText('CardReader')).toBe('from-reader');
    expect(tab.receivedText('Scale')).toBe('from-scale');
  });
});
