import { describe, expect, it } from 'vitest';

import { SerialBrokerClient } from '../../../src/client/serial-broker-client.js';
import type { ProtocolMessage } from '../../../src/protocol/messages.js';
import { BrowserHarness } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import type { TransportMode } from '../../harness/fake-bus.js';

/**
 * Writes the tab holding the port accepts from other tabs, and what it remembers of them to keep
 * each write at most once (ADR-0013).
 */

const TRANSPORTS: readonly TransportMode[] = ['sharedworker', 'broadcastchannel'];

describe.each(TRANSPORTS)('a write that found the port closed (%s)', (transport) => {
  it('is written once the port is open again, not answered with NOT_CONNECTED again', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);

    // A tab whose incoming messages can be held back, as a busy main thread holds them back.
    const held: ProtocolMessage[] = [];
    let isHolding = false;
    let deliver: (message: ProtocolMessage) => void = () => undefined;
    const environment = harness.createEnvironment('busy');
    const busy = new SerialBrokerClient({
      ...environment,
      createTransport: (request) => {
        deliver = request.onMessage;
        return environment.createTransport({
          ...request,
          onMessage: (message) => {
            if (isHolding) {
              held.push(message);
            } else {
              request.onMessage(message);
            }
          },
        });
      },
    });
    await busy.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // The device goes away. The busy tab has not heard yet and sends: the tab holding the port has
    // no open port to write to, and answers NOT_CONNECTED.
    isHolding = true;
    harness.serial.unplug(device);
    await harness.settle();
    const writing = busy.send('Reader', 'PING');
    await harness.settle();
    isHolding = false;
    for (const message of held.splice(0)) {
      deliver(message);
    }
    await harness.settle();

    // Back again: the write goes out once more, and this time it is written.
    harness.serial.plug(device);
    await harness.advance(0);
    await harness.settle();

    await expect(writing).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('PING');
  });
});
