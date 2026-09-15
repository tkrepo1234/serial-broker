import { describe, expect, it } from 'vitest';

import type { SerialBrokerClient } from '../../../src/client/serial-broker-client.js';
import { brokerChannelName } from '../../../src/protocol/version.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

/**
 * Defects in the tab holding the port found in the review of 2026-09-13, each pinned by the
 * behaviour it broke.
 */

function harnessWithDevice(transport: (typeof TRANSPORT_MODES)[number]) {
  const harness = new BrowserHarness({ transport });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  return { harness, device };
}

/** How many writes wait at the port of the tab holding it, as the diagnostics report says. */
function queuedWritesAt(client: SerialBrokerClient): number | undefined {
  return client.diagnostics()?.configurations[0]?.connection?.queuedWrites;
}

describe.each(TRANSPORT_MODES)('the tab that holds the port (%s)', (transport) => {
  it('keeps its own status when a status from the former holder arrives late', async () => {
    const { harness, device } = harnessWithDevice(transport);
    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    const busy = harness.openBusyTab();
    await busy.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // The first tab loses the connection and says so; the busy tab has not heard yet when the
    // first tab dies and hands it the port.
    busy.hold();
    device.breakStream();
    await harness.settle();
    await first.kill();
    await harness.advance(0);
    expect(busy.client.getStatus('Reader').status).toBe('open');
    busy.deliverHeld();
    await harness.settle();

    expect(busy.client.getStatus('Reader').status).toBe('open');
    await busy.client.send('Reader', 'PING');
    expect(device.writtenText()).toBe('PING');
  });

  it('writes its own write once when a former holder turns it away late', async () => {
    const { harness, device } = harnessWithDevice(transport);
    const first = harness.openTab();
    await first.setup('Reader', READER_OPTIONS);
    const busy = harness.openBusyTab();
    await busy.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // The busy tab still believes the first tab's port is open, and sends two writes there. The
    // first tab has lost the connection and turns both away; the answers are held.
    busy.hold();
    device.breakStream();
    await harness.settle();
    void busy.client.send('Reader', 'ONE').catch(() => undefined);
    void busy.client.send('Reader', 'TWO').catch(() => undefined);
    await harness.settle();

    // The busy tab takes the port over and writes both itself: the first hangs at the device, the
    // second waits behind it. Then the old answers arrive.
    device.faults.hangOnWrite = true;
    await first.kill();
    expect(queuedWritesAt(busy.client)).toBe(2);
    busy.deliverHeld();
    await harness.settle();

    expect(queuedWritesAt(busy.client)).toBe(2);
  });

  it('accepts a repeated write only once, however many writes it has accepted since', async () => {
    const { harness, device } = harnessWithDevice(transport);
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const participant = harness.openTab();
    await participant.setup('Reader', READER_OPTIONS);

    // More writes than the tab holding the port remembers finished ones, all still waiting there
    // behind one that hangs.
    device.faults.hangOnWrite = true;
    for (let index = 0; index < 1_100; index += 1) {
      void participant.client.send('Reader', `W${String(index)}`).catch(() => undefined);
    }
    await harness.settle();
    const queued = queuedWritesAt(owner.client);
    expect(queued).toBe(1_100);

    // A tab joining asks for the status; hearing `open` again, the participant hands on every
    // write that has not started.
    const joining = harness.openTab();
    await joining.setup('Reader', READER_OPTIONS);

    expect(queuedWritesAt(owner.client)).toBe(queued);
  });
});

describe('a write of another tab during a clean release', () => {
  it('is sent once, and written by the next holder once the term has ended', async () => {
    const { harness, device } = harnessWithDevice('broadcastchannel');
    const holder = harness.openTab();
    await holder.setup('Reader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('Reader', READER_OPTIONS);
    const requests: unknown[] = [];
    const spy = harness.bus.broadcastHub.create(brokerChannelName(), 'spy');
    spy.addEventListener('message', (event: { data: unknown }) => {
      if ((event.data as { type?: unknown }).type === 'write-request') {
        requests.push(event.data);
      }
    });

    // A write of the other tab is in flight at the port, so the release waits for its answer, and
    // the next write reaches the holding tab after it let go of the port and before its goodbye.
    device.pauseWrites();
    const first = other.client.send('Reader', 'A').catch((error: unknown) => error);
    await harness.settle();
    const releasing = holder.client.release('Reader');
    for (let round = 0; round < 10; round += 1) {
      await harness.settle();
    }
    const second = other.client.send('Reader', 'B');
    for (let round = 0; round < 20; round += 1) {
      await harness.settle();
    }

    // One request per write: a releasing tab hears nothing more, so nothing turns the second write
    // away to be sent to the same term again; its issuer waits for the term to end.
    expect(requests).toHaveLength(2);

    device.resumeWrites();
    await harness.advance(5_000);
    await releasing;
    await first;
    await harness.settle();
    await expect(second).resolves.toBeUndefined();
    expect(device.writtenText()).toContain('B');
  });
});
