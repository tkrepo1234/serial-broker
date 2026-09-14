import { describe, expect, it } from 'vitest';

import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

/**
 * Durations survive the system clock being set (ADR-0032).
 *
 * The user correcting the time, a time zone change, an NTP step: `Date.now()` jumps forwards or
 * backwards while the timers keep counting. Everything this library times - how long a connection
 * held, how long a write has waited, how late a deadline ran - is therefore measured on the
 * monotonic clock, and a jump must change none of it.
 */
describe('a system clock that is set', () => {
  async function connectedTab(logger: ReturnType<typeof recordingLogger>['logger']) {
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    // One failed open first, so the attempt counter is above zero and a reset is visible.
    device.faults.failOpenTimes = 1;
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await harness.advance(0);
    await harness.settle();
    return { harness, device, tab };
  }

  it('does not make a connection that held for stableAfterMs count as unstable', async () => {
    const { logger, records } = recordingLogger();
    const { harness, device } = await connectedTab(logger);

    // An hour back while the port is open: the connection has still held for six seconds.
    harness.clock.jumpWallClock(-3_600_000);
    await harness.advance(6_000);
    device.faults.failOpenWith = 'NetworkError';
    device.breakStream();
    await harness.settle();

    const delays = fieldsOfEvent(records, 'supervisor.reconnect').map(
      (fields) => fields['delayMs'],
    );
    // The first retry after the failed open, then the immediate retry a connection that held
    // earns. Measured on the wall clock, the second would have been a 250 ms backoff delay.
    expect(delays).toEqual([0, 0]);
  });

  it('does not make a connection that broke at once count as stable', async () => {
    const { logger, records } = recordingLogger();
    const { harness, device } = await connectedTab(logger);

    // An hour forward while the port is open: the connection has still held for a moment only.
    harness.clock.jumpWallClock(3_600_000);
    await harness.advance(100);
    device.faults.failOpenWith = 'NetworkError';
    device.breakStream();
    await harness.settle();

    const delays = fieldsOfEvent(records, 'supervisor.reconnect').map(
      (fields) => fields['delayMs'],
    );
    // Measured on the wall clock, the connection would have looked an hour old and the retry
    // immediate - which is how a device that opens and drops at once loops forever.
    expect(delays).toEqual([0, 250]);
  });
});
