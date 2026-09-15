import { describe, expect, it } from 'vitest';

import { SerialBrokerStatus } from '../../src/core/types.js';
import type { SerialBrokerOptions } from '../../src/core/types.js';
import { BrowserHarness, type VirtualTab } from '../harness/browser-harness.js';
import { READER } from '../harness/devices.js';

/**
 * How what the device sends is collected into `onReceive` events (ADR-0039): the tab holding the
 * port collects the chunks it reads until the line is quiet, and every tab receives the same
 * deliveries.
 */

const OPTIONS: SerialBrokerOptions = {
  device: READER,
  serial: { baudRate: 9600 },
  encoding: { decodeText: true },
};

async function twoTabs(options: Partial<SerialBrokerOptions> = {}) {
  const harness = new BrowserHarness();
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const owner = harness.openTab();
  await owner.setup('Reader', { ...OPTIONS, ...options });
  const peer = harness.openTab();
  await peer.setup('Reader', { ...OPTIONS, ...options });
  await harness.settle();
  return { harness, device, owner, peer };
}

/** Every `onReceive` of a tab, as its text, and every status change, in the order they came. */
function eventsOf(tab: VirtualTab): string[] {
  const events: string[] = [];
  tab.client.subscribe('Reader', 'onReceive', (event) =>
    events.push(`receive:${event.text ?? ''}`),
  );
  tab.client.subscribe('Reader', 'onStatusChange', (event) =>
    events.push(`status:${event.status}`),
  );
  return events;
}

describe('receiving', () => {
  it('delivers an answer that arrives byte by byte as one event, in every tab', async () => {
    const { harness, device, owner, peer } = await twoTabs();
    const atOwner = eventsOf(owner);
    const atPeer = eventsOf(peer);

    for (const character of ['1', '2', '3', '4', '\r', '\n']) {
      device.emit(character);
      await harness.advance(10);
    }
    expect(atOwner).toEqual([]);
    await harness.advance(50);

    expect(atOwner).toEqual(['receive:1234\r\n']);
    expect(atPeer).toEqual(['receive:1234\r\n']);
  });

  it('delivers every chunk as it is read with an idle time of 0', async () => {
    const { harness, device, owner } = await twoTabs({ receive: { idleMs: 0 } });
    const events = eventsOf(owner);

    device.emit('1');
    await harness.settle();
    device.emit('2');
    await harness.settle();

    expect(events).toEqual(['receive:1', 'receive:2']);
  });

  it('delivers a line that never goes quiet at the pace of the longest wait', async () => {
    const { harness, device, owner } = await twoTabs({ receive: { idleMs: 50, maxWaitMs: 200 } });
    const events = eventsOf(owner);

    for (let index = 0; index < 25; index += 1) {
      device.emit('x');
      await harness.advance(10);
    }

    expect(events[0]).toBe(`receive:${'x'.repeat(20)}`);
  });

  it('delivers what was collected before the lost connection is reported', async () => {
    const { harness, device, owner } = await twoTabs();
    const events = eventsOf(owner);

    device.emit('PARTIAL');
    await harness.settle();
    device.breakStream();
    await harness.settle();

    expect(events.slice(0, 2)).toEqual([
      'receive:PARTIAL',
      `status:${SerialBrokerStatus.Reconnecting}`,
    ]);
  });
});
