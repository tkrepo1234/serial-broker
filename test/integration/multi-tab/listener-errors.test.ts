import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { BrowserHarness, TRANSPORT_MODES, type VirtualTab } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import type { TransportMode } from '../../harness/fake-bus.js';

/**
 * A listener that throws is a defect in the tab it belongs to, and is reported there only.
 */

async function twoTabs(transport: TransportMode): Promise<{
  harness: BrowserHarness;
  device: ReturnType<BrowserHarness['serial']['addDevice']>;
  owner: VirtualTab;
  other: VirtualTab;
}> {
  const harness = new BrowserHarness({ transport });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const owner = harness.openTab();
  await owner.setup('Reader', READER_OPTIONS);
  const other = harness.openTab();
  await other.setup('Reader', READER_OPTIONS);
  return { harness, device, owner, other };
}

describe.each(TRANSPORT_MODES)('a listener that throws (%s)', (transport) => {
  it.each(['the tab holding the port', 'another tab'] as const)(
    'in %s is reported there only, and the others still receive',
    async (where) => {
      const { harness, device, owner, other } = await twoTabs(transport);
      const [throwing, quiet] = where === 'another tab' ? [other, owner] : [owner, other];
      throwing.client.subscribe('Reader', 'onReceive', () => {
        throw new Error('application bug');
      });

      device.emit('x');
      await harness.settle();

      // Both tabs heard the chunk, so each had every chance to report something.
      expect(throwing.errorCodes('Reader')).toContain(SerialBrokerErrorCode.LISTENER_THREW);
      expect(quiet.errorCodes('Reader')).not.toContain(SerialBrokerErrorCode.LISTENER_THREW);
      expect(throwing.receivedText('Reader')).toBe('x');
      expect(quiet.receivedText('Reader')).toBe('x');
    },
  );
});
