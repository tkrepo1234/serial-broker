import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { recordingLogger } from '../harness/recording-logger.js';

/**
 * What an operator sees when something goes wrong.
 *
 * A hardware library whose failure mode is silence is unusable in the field: the device is in
 * another room, the tab is on a machine nobody is sitting at, and the only evidence is what
 * the library chose to report.
 */
describe('error reporting', () => {
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

  it('reports a failed write to the caller and to every tab', async () => {
    const { harness, device, tab } = await connectedTab();
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);
    device.faults.failWriteWith = 'NetworkError';

    await expect(tab.client.send('Reader', 'x')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.WRITE_FAILED,
    });
    await harness.settle();

    // The caller learns because its promise rejected; the other tabs learn because their
    // device just stopped working too.
    expect(peer.recordFor('Reader').errors.map((event) => event.error.code)).toContain(
      SerialBrokerErrorCode.WRITE_FAILED,
    );
  });

  it('says how many bytes reached the device before a write failed', async () => {
    const { harness, device, tab } = await connectedTab();
    device.faults.failWriteWith = 'NetworkError';

    const error = await tab.client.send('Reader', 'abc').catch((reason: unknown) => reason);
    await harness.settle();

    // "It failed" is not enough to decide whether repeating the command is safe.
    expect((error as { context: Record<string, unknown> }).context).toMatchObject({
      bytesWritten: 0,
      byteLength: 3,
    });
  });

  it('rebuilds an error raised in another tab faithfully', async () => {
    const { harness, device, tab } = await connectedTab();
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);
    device.faults.failWriteWith = 'NetworkError';

    await tab.client.send('Reader', 'x').catch(() => undefined);
    await harness.settle();

    const remote = peer.recordFor('Reader').errors.at(-1)?.error;
    expect(remote?.code).toBe(SerialBrokerErrorCode.WRITE_FAILED);
    expect(remote?.remediation).toContain('bytesWritten');
    expect(remote?.configName).toBe('Reader');
  });

  it('reports an error exactly once per tab', async () => {
    const { harness, device } = await connectedTab();
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);

    harness.serial.unplug(device);
    await harness.settle();

    const disconnects = peer
      .recordFor('Reader')
      .errors.filter((event) => event.error.code === SerialBrokerErrorCode.DEVICE_DISCONNECTED);
    expect(disconnects).toHaveLength(1);
  });

  it('keeps the last error code in the status snapshot', async () => {
    const { harness, device, tab } = await connectedTab();

    harness.serial.unplug(device);
    await harness.settle();

    expect(tab.client.getStatus('Reader').lastErrorCode).toBe(
      SerialBrokerErrorCode.DEVICE_DISCONNECTED,
    );
  });

  it('marks an error the library is already handling as retryable', async () => {
    const { harness, device, tab } = await connectedTab();

    harness.serial.unplug(device);
    await harness.settle();

    const error = tab.recordFor('Reader').errors.at(0)?.error;
    expect(error?.isRetryable).toBe(true);
    expect(error?.remediation).toContain('No action required');
  });

  it('reports a listener that throws without disturbing the others', async () => {
    const { harness, device, tab } = await connectedTab();
    const good = vi.fn();

    tab.client.subscribe('Reader', 'onReceive', () => {
      throw new Error('application bug');
    });
    tab.client.subscribe('Reader', 'onReceive', good);
    device.emit('x');
    await harness.settle();

    expect(good).toHaveBeenCalledOnce();
    expect(tab.recordFor('Reader').errors.map((event) => event.error.code)).toContain(
      SerialBrokerErrorCode.LISTENER_THREW,
    );
  });

  it('rejects a pending write when the configuration is released', async () => {
    const { harness, device, tab } = await connectedTab();
    device.faults.hangOnWrite = true;

    const outcome = tab.client.send('Reader', 'x').catch((reason: unknown) => reason);
    await harness.settle();

    // Not awaited yet: `release` drains the write queue first, so a command already on its way
    // to the device is not truncated, and that drain runs to its own deadline against a device
    // that has stopped answering.
    const released = tab.client.release('Reader');

    // The caller's promise settles immediately, though. A promise that never settles is the
    // worst possible answer to "I released it".
    expect(await outcome).toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_RELEASED,
    });

    // Teardown itself is bounded: draining, then cancelling the reader, then aborting the
    // writer, then closing the port - every one of which waits on a device that has stopped
    // answering, and every one of which therefore has its own deadline.
    await harness.advance(60_000);
    await released;
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('fails a write that never finds a connection, within the deadline', async () => {
    const harness = new BrowserHarness();
    harness.serial.addDevice(READER.vendorId, READER.productId);
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, connection: { writeTimeoutMs: 1_000 } });

    const outcome = tab.client.send('Reader', 'x').catch((reason: unknown) => reason);
    await harness.advance(1_000);

    expect(await outcome).toMatchObject({ code: SerialBrokerErrorCode.WRITE_TIMEOUT });
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('refuses to send to a configuration that is not set up', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();

    await expect(tab.client.send('Nothing', 'x')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.UNKNOWN_CONFIGURATION,
    });
  });

  it('refuses to request access for a configuration owned by another tab', async () => {
    const harness = new BrowserHarness();
    harness.serial.addDevice(READER.vendorId, READER.productId);
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);

    // Only the tab that will hold the port can act on the picker's result, so asking from
    // anywhere else would prompt the user for nothing.
    await expect(peer.client.requestAccess('Reader')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.PERMISSION_REQUIRED,
    });
  });

  it('does nothing when access is requested for a port that is already open', async () => {
    const { harness, tab } = await connectedTab();
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);

    await expect(peer.client.requestAccess('Reader')).resolves.toBe(true);
    expect(tab.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });
});

describe('logging', () => {
  it('writes nothing unless an application asks for it', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();

    // No logger configured. A library that writes to the host console uninvited is a bad
    // citizen, and the absence of output is the behaviour being asserted.
    await expect(tab.setup('Reader', READER_OPTIONS)).resolves.toBeUndefined();
  });

  it('records lifecycle milestones with correlating fields', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    const milestones = records.filter(([level]) => level === 'info').map(([, message]) => message);
    expect(milestones).toContain('configuration registered');
    expect(milestones).toContain('acquired port ownership');
    expect(milestones).toContain('port opened');

    for (const [, , fields] of records) {
      expect(fields).toHaveProperty('clientId');
    }
  });

  it('never puts payload bytes in a record at info or above', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    await tab.client.send('Reader', 'PIN=1234');
    device.emit('CARD=5555444433332222');
    await harness.settle();

    // Serial traffic routinely carries card numbers and PINs. A support engineer reading a
    // console dump must not be reading those.
    const visible = records
      .filter(([level]) => level !== 'debug')
      .map(([, message, fields]) => `${message} ${JSON.stringify(fields)}`)
      .join('\n');
    expect(visible).not.toContain('1234');
    expect(visible).not.toContain('5555');
  });

  it('records traffic at debug level as a byte count, with no bytes', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    await tab.client.send('Reader', 'PIN=1234');
    device.emit('CARD=5555');
    await harness.settle();

    const traffic = records.filter(([, message]) => message === 'sent' || message === 'received');
    expect(traffic).toHaveLength(2);
    for (const [level, , fields] of traffic) {
      expect(level).toBe('debug');
      expect(fields['byteLength']).toBeGreaterThan(0);
      // The default: a support engineer sees that traffic happened, not what it said.
      expect(fields).not.toHaveProperty('hex');
    }
  });

  it('includes payload bytes only when the application asks for them', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger, logPayloads: true });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    await tab.client.send('Reader', 'AT');
    await harness.settle();

    const sent = records.find(([, message]) => message === 'sent');
    expect(sent?.[2]['hex']).toBe('41 54');
  });
  it('warns when a reconnect is scheduled, with the reason and the delay', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    harness.serial.unplug(device);
    await harness.settle();

    const warning = records.find(([, message]) => message.includes('scheduling reconnect'));
    expect(warning?.[2]).toMatchObject({ configName: 'Reader' });
    expect(warning?.[2]).toHaveProperty('delayMs');
  });
});
