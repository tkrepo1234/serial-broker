import { describe, expect, it } from 'vitest';

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import type { SerialLike } from '../../src/environment/environment.js';
import type { BrowserHarness } from '../harness/browser-harness.js';
import { TRANSPORT_MODES, VirtualTab } from '../harness/browser-harness.js';
import { READER_OPTIONS, readerHarness } from '../harness/devices.js';
import { domException } from '../harness/fake-serial.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

/**
 * A connection attempt that fails with an error that is not retryable ends in `failed` at once.
 *
 * docs/site/errors.md promises that only retryable codes lead to further attempts. A `SecurityError`
 * from `open()` - serial blocked by a permissions policy - is reported as `WEB_SERIAL_UNAVAILABLE`,
 * and every further attempt would meet it again, forever under the default `maxAttempts`. See
 * ADR-0010.
 */

function harnessWithBlockedDevice() {
  const { logger, records } = recordingLogger();
  const { harness, device } = readerHarness({ logger });
  device.faults.failOpenWith = 'SecurityError';
  return { harness, device, records };
}

describe('an open() the browser refuses for security reasons', () => {
  it('ends in failed with WEB_SERIAL_UNAVAILABLE, and no attempt follows', async () => {
    const { harness, device } = harnessWithBlockedDevice();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Failed,
      lastErrorCode: SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
    });
    expect(tab.errorCodes('Reader')).toEqual([SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE]);
    expect(harness.clock.nextTimerInMs).toBeUndefined();

    await harness.advance(10 * 60_000);
    expect(device.openCount).toBe(0);
    expect(tab.statusTrail('Reader')).toEqual([SerialBrokerStatus.Failed]);
  });

  it('reports no RECONNECT_EXHAUSTED, and says in the log that it gave up', async () => {
    const { harness, records } = harnessWithBlockedDevice();
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { maxAttempts: 3 } });
    await harness.advance(60_000);

    expect(tab.errorCodes('Reader')).not.toContain(SerialBrokerErrorCode.RECONNECT_EXHAUSTED);
    expect(fieldsOfEvent(records, 'supervisor.reconnect')).toEqual([]);
    expect(fieldsOfEvent(records, 'supervisor.gave-up')).toEqual([
      expect.objectContaining({ reason: 'open-failed', attempt: 1 }),
    ]);
  });

  it('tries once more when the device is plugged in again', async () => {
    const { harness, device } = harnessWithBlockedDevice();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);

    device.faults.failOpenWith = undefined;
    harness.serial.plug(device);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('tries exactly once more on a device event when the refusal persists', async () => {
    const { harness, device } = harnessWithBlockedDevice();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    harness.serial.plug(device);
    await harness.settle();
    await harness.advance(60_000);

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);
    expect(tab.errorCodes('Reader')).toEqual([
      SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
      SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
    ]);
  });

  it('tries once more when the configuration is released and set up again', async () => {
    const { harness, device } = harnessWithBlockedDevice();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await tab.client.release('Reader');

    device.faults.failOpenWith = undefined;
    await tab.setup('Reader', READER_OPTIONS);

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('still retries an open() that fails for a retryable reason', async () => {
    const { harness, device } = readerHarness();
    device.faults.failOpenWith = 'InvalidStateError';
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Reconnecting);
    expect(harness.clock.nextTimerInMs).toBe(0);
  });
});

describe.each(TRANSPORT_MODES)('a refused open() seen from another tab (%s)', (transport) => {
  it('shows failed there too', async () => {
    const { harness, device } = readerHarness({ transport });
    device.faults.failOpenWith = 'SecurityError';
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);

    expect(peer.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);
  });
});

describe('granted ports the browser refuses to list', () => {
  /** A tab whose `getPorts()` rejects with `SecurityError` while `refuse` is set. */
  function openRefusingTab(harness: BrowserHarness): { tab: VirtualTab; refuse: { on: boolean } } {
    const refuse = { on: true };
    const environment = harness.createEnvironment('refusing');
    const serial = environment.serial;
    const refusing: SerialLike = {
      getPorts: async () => {
        if (refuse.on) {
          throw domException('SecurityError', 'Access to serial is disallowed');
        }
        return await serial.getPorts();
      },
      requestPort: async (options) => await serial.requestPort(options),
      addEventListener: (type, listener) => {
        serial.addEventListener(type, listener);
      },
      removeEventListener: (type, listener) => {
        serial.removeEventListener(type, listener);
      },
    };
    const tab = new VirtualTab(
      'refusing',
      new SerialBrokerClient({ ...environment, serial: refusing }),
      harness,
    );
    return { tab, refuse };
  }

  it('end in failed, not in awaiting-permission, and are not listed again', async () => {
    const { harness, device } = readerHarness();
    const { tab, refuse } = openRefusingTab(harness);
    await tab.setup('Reader', READER_OPTIONS);

    expect(tab.client.getStatus('Reader')).toMatchObject({
      status: SerialBrokerStatus.Failed,
      lastErrorCode: SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE,
    });
    expect(harness.clock.nextTimerInMs).toBeUndefined();

    refuse.on = false;
    harness.serial.plug(device);
    await harness.settle();
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });
});
