import { describe, expect, it } from 'vitest';

import { TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { connectedTabs } from '../../harness/devices.js';

/**
 * `ReceiveEvent.afterGap`: whether bytes may be missing before a delivery, in the tab it reaches.
 *
 * An application assembling lines or frames across deliveries has to know when to start afresh.
 * Each tab decides it from what it saw itself - its first delivery, a status other than `open`, a
 * message bus that replaced one that died - so the answer needs nothing on the wire.
 */

/** Each delivery a tab received, as `text` or `gap:text`. */
function deliveries(tab: VirtualTab): string[] {
  return tab
    .recordFor('Reader')
    .received.map(
      (event) => `${event.afterGap ? 'gap:' : ''}${new TextDecoder().decode(event.data)}`,
    );
}

describe.each(TRANSPORT_MODES)('a delivery after a gap (%s)', (transport) => {
  it('is the first one of every tab, and only the first while nothing happens', async () => {
    const { harness, device, tabs } = await connectedTabs(2, { transport });

    device.emit('A');
    await harness.settle();
    device.emit('B');
    await harness.settle();

    for (const tab of tabs) {
      expect(deliveries(tab)).toEqual(['gap:A', 'B']);
    }
  });

  it('follows an unplugged device that came back, in every tab', async () => {
    const { harness, device, tabs } = await connectedTabs(2, { transport });
    device.emit('A');
    await harness.settle();

    harness.serial.unplug(device);
    await harness.settle();
    harness.serial.plug(device);
    await harness.advance(1_000);
    device.emit('B');
    await harness.settle();
    device.emit('C');
    await harness.settle();

    for (const tab of tabs) {
      expect(deliveries(tab)).toEqual(['gap:A', 'gap:B', 'C']);
    }
  });

  it('follows a handover to another tab', async () => {
    const { harness, device, tabs } = await connectedTabs(2, { transport });
    const [first, second] = tabs as [VirtualTab, VirtualTab];
    device.emit('A');
    await harness.settle();

    await first.close();
    await harness.advance(5_000);
    device.emit('B');
    await harness.settle();

    expect(deliveries(second)).toEqual(['gap:A', 'gap:B']);
  });

  it('follows a crash of the tab holding the port', async () => {
    const { harness, device, tabs } = await connectedTabs(2, { transport });
    const [first, second] = tabs as [VirtualTab, VirtualTab];
    device.emit('A');
    await harness.settle();

    await first.kill();
    await harness.advance(5_000);
    device.emit('B');
    await harness.settle();

    expect(deliveries(second)).toEqual(['gap:A', 'gap:B']);
  });
});

describe('a delivery after the worker died', () => {
  it('follows the replaced message bus, though the port stayed open', async () => {
    const { harness, device, tabs } = await connectedTabs(2, { transport: 'sharedworker' });
    device.emit('A');
    await harness.settle();

    harness.bus.crashWorker();
    await harness.advance(5_000);
    device.emit('B');
    await harness.settle();

    for (const tab of tabs) {
      expect(tab.statusTrail('Reader')).toEqual(['open']);
      expect(deliveries(tab)).toEqual(['gap:A', 'gap:B']);
    }
  });
});
