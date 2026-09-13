import { describe, expect, it } from 'vitest';

import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * Writes the tab holding the port accepts from other tabs, and what it remembers of them to keep
 * each write at most once (ADR-0013).
 */

describe.each(TRANSPORT_MODES)('a write that found the port closed (%s)', (transport) => {
  it('is written once the port is open again, not answered with NOT_CONNECTED again', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);

    const busy = harness.openBusyTab();
    await busy.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // The device goes away. The busy tab has not heard yet and sends: the tab holding the port has
    // no open port to write to, and answers NOT_CONNECTED.
    busy.hold();
    harness.serial.unplug(device);
    await harness.settle();
    const writing = busy.client.send('Reader', 'PING');
    await harness.settle();
    busy.deliverHeld();
    await harness.settle();

    // Back again: the write goes out once more, and this time it is written.
    harness.serial.plug(device);
    await harness.advance(0);
    await harness.settle();

    await expect(writing).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('PING');
  });
});
