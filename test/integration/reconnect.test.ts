import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/**
 * Keeping the port open across a device being switched off, unplugged or power-cycled.
 *
 * Backoff is asserted exactly, not approximately: the harness fixes the jitter draw, so a
 * schedule is a sequence of numbers a test can name. See ADR-0010.
 */
describe('reconnect supervision', () => {
  async function connectedTab(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    tab: ReturnType<BrowserHarness['openTab']>;
  }> {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    return { harness, device, tab };
  }

  it('reopens the port automatically when the device comes back', async () => {
    const { harness, device, tab } = await connectedTab();

    harness.serial.unplug(device);
    await harness.settle();
    harness.serial.plug(device);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(2);
  });

  it('resumes receiving data after a power cycle, with no application action', async () => {
    const { harness, device, tab } = await connectedTab();

    device.emit('BEFORE');
    // Settled before unplugging: a chunk still sitting in the stream's queue when the stream
    // errors is genuinely lost, on real hardware as much as here. The scenario under test is
    // "data arrived, then the device went away", not "data and the failure raced".
    await harness.settle();

    harness.serial.unplug(device);
    await harness.settle();
    harness.serial.plug(device);
    await harness.settle();
    device.emit('AFTER');
    await harness.settle();

    expect(tab.receivedText('Reader')).toBe('BEFOREAFTER');
  });

  it('does not wait before the first retry', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenTimes = 1;

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    // A power-cycled device is usually back within one event-loop turn. Waiting 250 ms for
    // the first retry would turn a non-event into a visible outage (ADR-0010).
    expect(harness.clock.nextTimerInMs).toBe(0);
    await harness.advance(0);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('retries at once only once, then backs off as from a fresh start', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    await harness.openTab().setup('Reader', READER_OPTIONS);
    // Longer than stableAfterMs, so the attempt count starts over when the connection breaks.
    await harness.advance(6_000);

    device.faults.failOpenWith = 'NetworkError';
    device.breakStream();
    await harness.settle();
    const delays: (number | undefined)[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      delays.push(harness.clock.nextTimerInMs);
      await harness.clock.advanceToNextTimer();
      await harness.settle();
    }

    // Before the fix this was [0, 0, 250, 500]: two immediate retries in a row.
    expect(delays).toEqual([0, 250, 500, 1000]);
  });

  it('never waits longer than maxDelayMs between attempts', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'NetworkError';

    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { maxDelayMs: 1_000 } });

    const delays: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      delays.push(harness.clock.nextTimerInMs ?? -1);
      await harness.clock.advanceToNextTimer();
      await harness.settle();
    }

    expect(delays).toEqual([0, 250, 500, 1000, 1000, 1000, 1000]);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Reconnecting);
  });

  it('stops retrying after maxAttempts and says so once in every tab', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'NetworkError';
    const options = { ...READER_OPTIONS, connection: { maxAttempts: 3 } };

    const tab = harness.openTab();
    await tab.setup('Reader', options);
    const peer = harness.openTab();
    await peer.setup('Reader', options);
    await harness.advance(10_000);

    for (const each of [tab, peer]) {
      expect(each.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);
      expect(
        each
          .errorCodes('Reader')
          .filter((code) => code === SerialBrokerErrorCode.RECONNECT_EXHAUSTED),
      ).toHaveLength(1);
    }
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('reconnects when the device ends the stream without an error', async () => {
    const { harness, device, tab } = await connectedTab();

    // A device can close its end cleanly - a firmware reset, a USB-serial bridge restarting -
    // and the read loop then sees the stream finish instead of fail. The connection is gone all
    // the same.
    device.endStream();
    await harness.settle();
    expect(tab.errorCodes('Reader')).toEqual([SerialBrokerErrorCode.DEVICE_DISCONNECTED]);

    await harness.advance(0);
    device.emit('BACK');
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(device.openCount).toBe(2);
    expect(tab.receivedText('Reader')).toBe('BACK');
  });

  it('revives a failed configuration when the device is plugged in again', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'NetworkError';

    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { maxAttempts: 2 } });
    await harness.advance(10_000);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Failed);

    // The terminal state exists to stop pointless retrying, not to require a restart.
    device.faults.failOpenWith = undefined;
    harness.serial.plug(device);
    await harness.settle();

    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('cancels a pending backoff delay when the device reappears', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'NetworkError';

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await harness.advance(3_000);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Reconnecting);

    device.faults.failOpenWith = undefined;
    harness.serial.plug(device);
    await harness.settle();

    // No clock advance: the platform said the device is back, so waiting out the remaining
    // backoff would be a delay for nothing.
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });

  it('treats a hung open() as a failed attempt rather than wedging', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.hangOnOpen = true;

    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    await harness.advance(10_000);

    // Without a deadline on open(), the state machine would sit in `connecting` forever with
    // no way out and no error to show anyone.
    const timeouts = tab
      .recordFor('Reader')
      .errors.filter((event) => event.error.code === SerialBrokerErrorCode.OPEN_TIMEOUT);
    expect(timeouts.length).toBeGreaterThan(0);
    // Still trying, in one phase or the other - which phase it is at this instant depends on
    // where in the retry cycle the clock stopped, and asserting on that would be a test of
    // the test's arithmetic rather than of the library.
    expect([SerialBrokerStatus.Connecting, SerialBrokerStatus.Reconnecting]).toContain(
      tab.client.getStatus('Reader').status,
    );
  });

  it('tells every tab about a reconnection, not just the one that owns the port', async () => {
    const { harness, device, tab } = await connectedTab();
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);

    harness.serial.unplug(device);
    await harness.settle();

    expect(peer.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Reconnecting);
    expect(tab.statusTrail('Reader')).toContain(SerialBrokerStatus.Reconnecting);
  });
});
