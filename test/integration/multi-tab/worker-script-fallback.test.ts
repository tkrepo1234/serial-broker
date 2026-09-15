import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import type { LogFields } from '../../../src/core/types.js';
import { HANDSHAKE_DEADLINE_MS } from '../../../src/protocol/handshake.js';
import { BrowserHarness } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';
import { recordingLogger } from '../../harness/recording-logger.js';

/**
 * A worker script that was not deployed, or is served from the wrong path (ADR-0007).
 *
 * The browser still creates the `SharedWorker` and reports the failure only afterwards - by which
 * time each tab has announced itself, attached, and one of them has claimed the port. These
 * scenarios check that the tabs then coordinate over `BroadcastChannel` as if they had started
 * there.
 */
describe('tabs whose worker script fails to load', () => {
  async function twoTabs(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    owner: ReturnType<BrowserHarness['openTab']>;
    other: ReturnType<BrowserHarness['openTab']>;
  }> {
    const harness = new BrowserHarness({ transport: 'sharedworker', workerScript: 'fails' });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);

    const owner = harness.openTab();
    await owner.setup('CardReader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('CardReader', READER_OPTIONS);

    return { harness, device, owner, other };
  }

  it('share the port over BroadcastChannel once the failure is reported', async () => {
    const { harness, device, owner, other } = await twoTabs();

    harness.bus.failWorkerScripts();
    await harness.settle();

    device.emit('CARD:1234');
    await harness.settle();
    await other.client.send('CardReader', 'STATUS?');
    await harness.settle();

    expect(owner.receivedText('CardReader')).toBe('CARD:1234');
    expect(other.receivedText('CardReader')).toBe('CARD:1234');
    expect(device.writtenText()).toBe('STATUS?');
    expect(device.written).toHaveLength(1);
    expect(device.openCount).toBe(1);
    expect(owner.client.transportKind).toBe('broadcastchannel');
    expect(other.client.transportKind).toBe('broadcastchannel');
  });

  it('show a joining tab the status it asked for before the failure', async () => {
    const { harness, other } = await twoTabs();
    // The request went into a worker that never ran, so nothing has answered it yet.
    expect(other.client.getStatus('CardReader').status).not.toBe(SerialBrokerStatus.Open);

    harness.bus.failWorkerScripts();
    await harness.settle();

    expect(other.client.getStatus('CardReader').status).toBe(SerialBrokerStatus.Open);
  });

  it('write what was sent before the failure, exactly once', async () => {
    const { harness, device, other } = await twoTabs();

    const sent = other.client.send('CardReader', 'PING');
    harness.bus.failWorkerScripts();
    await sent;
    await harness.settle();

    expect(device.writtenText()).toBe('PING');
    expect(device.written).toHaveLength(1);
  });
});

/**
 * A worker script of another protocol version: a copied worker file left over from an earlier
 * release, or one served from a cache (ADR-0024).
 *
 * Such a worker drops everything the tabs say, so they used to stay cut off from each other with
 * nothing reported. It still answers `hello` with a welcome in its own version, which tells a tab
 * that nothing it sent arrived anywhere - as when the script does not load at all.
 */
describe('tabs whose worker script is of another protocol version', () => {
  it('report the mismatch and share the port over BroadcastChannel', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({
      transport: 'sharedworker',
      workerScript: 'other-version',
      logger,
    });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.setup('CardReader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('CardReader', READER_OPTIONS);
    await harness.settle();

    device.emit('CARD:1234');
    await harness.settle();
    await other.client.send('CardReader', 'STATUS?');
    await harness.settle();

    expect(other.receivedText('CardReader')).toBe('CARD:1234');
    expect(device.writtenText()).toBe('STATUS?');
    expect(device.openCount).toBe(1);
    expect(owner.client.transportKind).toBe('broadcastchannel');
    expect(other.client.transportKind).toBe('broadcastchannel');

    // Reported before `setup()` returns, so the log is where both tabs can be seen to say it.
    const fields = records.map((record) => record[2]);
    for (const tab of [owner, other]) {
      expect(fields).toContainEqual(
        expect.objectContaining({
          context: tab.id,
          code: SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH,
        }) as LogFields,
      );
      expect(fields).toContainEqual(
        expect.objectContaining({
          context: tab.id,
          event: 'environment.transport-fallback',
          reason: 'worker-other-protocol-version',
        }) as LogFields,
      );
    }
  });

  it('stop starting workers once a worker that died is replaced by one of another version', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ transport: 'sharedworker', logger });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.setup('CardReader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('CardReader', READER_OPTIONS);
    await harness.settle();

    // Deployed again under the same worker URL while the tabs stayed open. The welcome of this
    // version came long ago, so there is nothing left to fall back from, and every worker started
    // from that URL runs the new script: only a reload helps (ADR-0024, amended).
    harness.bus.crashWorker('other-version');
    for (let round = 0; round < 10; round += 1) {
      await harness.busClock.advance(HANDSHAKE_DEADLINE_MS);
      await harness.settle();
    }

    const fields = records.map((record) => record[2]);
    for (const tab of [owner, other]) {
      expect(tab.recordFor('CardReader').errors.map((event) => event.error.code)).toEqual([
        SerialBrokerErrorCode.BROKER_UNAVAILABLE,
        SerialBrokerErrorCode.PROTOCOL_VERSION_MISMATCH,
      ]);
      const ofTab = fields.filter((entry) => entry['context'] === tab.id);
      expect(ofTab.filter((entry) => entry.event === 'transport.worker-restarted')).toHaveLength(1);
      expect(
        ofTab.filter((entry) => entry.event === 'transport.worker-other-protocol-version'),
      ).toHaveLength(1);
    }
  });
});
