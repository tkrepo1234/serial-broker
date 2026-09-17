import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import type { LogFields } from '../../../src/core/types.js';
import { HANDSHAKE_DEADLINE_MS } from '../../../src/protocol/handshake.js';
import {
  BrowserHarness,
  type HarnessOptions,
  type VirtualTab,
} from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS, readerHarness } from '../../harness/devices.js';
import type { FakeDevice } from '../../harness/fake-serial.js';
import { recordingLogger } from '../../harness/recording-logger.js';

/**
 * What only the `SharedWorker` transport can go through: tabs leaving a worker that is never told,
 * a worker that dies, and a worker script that does not load or is of another build. Everything
 * both transports share runs against both, in the files next to this one.
 */

/** A day, on the bus's clock: far longer than anything the worker could time. */
const DAY_MS = 24 * 3_600_000;

/** Two tabs that set `name` up one after the other on the SharedWorker: the first holds the port. */
async function twoTabs(
  options: { workerScript?: HarnessOptions['workerScript']; name?: string } = {},
): Promise<{ harness: BrowserHarness; device: FakeDevice; owner: VirtualTab; other: VirtualTab }> {
  const name = options.name ?? 'Reader';
  const harness = new BrowserHarness({
    transport: 'sharedworker',
    workerScript: options.workerScript ?? 'loads',
  });
  const device = harness.serial.addDevice(READER.vendorId, READER.productId);
  harness.serial.grant(device);
  const owner = harness.openTab();
  await owner.setup(name, READER_OPTIONS);
  const other = harness.openTab();
  await other.setup(name, READER_OPTIONS);
  return { harness, device, owner, other };
}

/**
 * Tabs that go away, as the worker experiences them (ADR-0024).
 *
 * A real worker is never told that a tab died, and the harness is not either. What tells it is the
 * Web Lock every tab holds for its lifetime, which the browser lets go of when the tab goes.
 */
describe('tabs on the SharedWorker', () => {
  it.each(['killed', 'closed'] as const)(
    'are forgotten by the worker as soon as the browser lets go of the lock of a tab %s',
    async (ending) => {
      const { harness, other } = await twoTabs();
      const before = harness.bus.workerHost.clientCount;

      await (ending === 'killed' ? other.kill() : other.close());

      // No time passes: nothing is timed.
      expect(before).toBe(2);
      expect(harness.bus.workerHost.clientCount).toBe(1);
    },
  );

  it('are all kept while they are alive, however long they stay idle, with nothing sent', async () => {
    const { harness, device, other } = await twoTabs();
    const sentBefore = harness.bus.meter.sent;

    await harness.busClock.advance(7 * DAY_MS);
    await harness.settle();
    const sentWhileIdle = harness.bus.meter.sent - sentBefore;
    device.emit('STILL HERE');
    await harness.settle();

    expect(sentWhileIdle).toBe(0);
    expect(harness.bus.workerHost.clientCount).toBe(2);
    expect(other.receivedText('Reader')).toBe('STILL HERE');
    expect(other.recordFor('Reader').errors).toEqual([]);
  });
});

/**
 * A worker that dies while tabs are open: it crashed, was ended for memory, or was terminated from
 * `chrome://inspect` (ADR-0024).
 *
 * A port to a dead worker reports nothing in either direction, and tabs opened later start a new
 * worker that knows none of the tabs already open. The browser lets go of the lock the worker held
 * for its lifetime, and every open tab waiting on it connects to the new worker at once. No time
 * passes in these scenarios: nothing about noticing the loss is timed.
 */
describe('tabs whose worker dies', () => {
  it('share the port again through a new worker, at once', async () => {
    const { harness, device, owner, other } = await twoTabs();

    harness.bus.crashWorker();
    await harness.settle();

    device.emit('AFTER');
    await harness.settle();
    await other.client.send('Reader', 'PING');
    await harness.settle();

    expect(other.receivedText('Reader')).toBe('AFTER');
    expect(device.writtenText()).toBe('PING');
    expect(harness.bus.workerHost.clientCount).toBe(2);
    expect(owner.client.transportKind).toBe('sharedworker');
    expect(other.client.transportKind).toBe('sharedworker');
  });

  it('each report the lost worker once', async () => {
    const { harness, owner, other } = await twoTabs();

    harness.bus.crashWorker();
    await harness.settle();
    await harness.busClock.advance(3_600_000);
    await harness.settle();

    for (const tab of [owner, other]) {
      expect(tab.recordFor('Reader').errors.map((event) => event.error.code)).toEqual([
        SerialBrokerErrorCode.BROKER_UNAVAILABLE,
      ]);
      // The tabs connect to a new worker on their own, so the application has nothing to act on.
      expect(tab.recordFor('Reader').errors.map((event) => event.error.isRetryable)).toEqual([
        true,
      ]);
    }
  });

  it('are joined by a tab opened after the crash', async () => {
    const { harness, device, other } = await twoTabs();

    // The new tab starts the new worker, which knows nothing of the tabs already open.
    harness.bus.crashWorker();
    const late = harness.openTab();
    await late.setup('Reader', READER_OPTIONS);
    await harness.settle();

    device.emit('TOGETHER');
    await harness.settle();

    expect(late.receivedText('Reader')).toBe('TOGETHER');
    expect(other.receivedText('Reader')).toBe('TOGETHER');
    expect(harness.bus.workerHost.clientCount).toBe(3);

    // It may have set up while the new worker knew no owner to ask for the status, and learns it
    // all the same: the owner restates it on reaching the new worker.
    expect(late.client.getStatus('Reader').status).toBe('open');
    const writing = late.client.send('Reader', 'LATE');
    await harness.settle();
    await expect(writing).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('LATE');
  });

  it('hand on a write that was lost with the dead worker, and write it once', async () => {
    const { harness, device, other } = await twoTabs();

    // Sent into the dead worker in the same task that ended it, before any tab could hear of it.
    harness.bus.crashWorker();
    const writing = other.client.send('Reader', 'LOST');
    await harness.settle();

    await expect(writing).resolves.toBeUndefined();
    expect(device.writtenText()).toBe('LOST');
    expect(device.written).toHaveLength(1);
  });
});

/**
 * A worker script that was not deployed, or is served from the wrong path (ADR-0006).
 *
 * The browser still creates the `SharedWorker` and reports the failure only afterwards - by which
 * time each tab has said hello, and one of them has claimed the port. These
 * scenarios check that the tabs then coordinate over `BroadcastChannel` as if they had started
 * there.
 */
describe('tabs whose worker script fails to load', () => {
  it('share the port over BroadcastChannel once the failure is reported', async () => {
    const { harness, device, owner, other } = await twoTabs({
      workerScript: 'fails',
      name: 'CardReader',
    });

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
    const { harness, other } = await twoTabs({ workerScript: 'fails', name: 'CardReader' });
    // The request went into a worker that never ran, so nothing has answered it yet.
    expect(other.client.getStatus('CardReader').status).not.toBe(SerialBrokerStatus.Open);

    harness.bus.failWorkerScripts();
    await harness.settle();

    expect(other.client.getStatus('CardReader').status).toBe(SerialBrokerStatus.Open);
  });

  it('write what was sent before the failure, exactly once', async () => {
    const { harness, device, other } = await twoTabs({ workerScript: 'fails', name: 'CardReader' });

    const sent = other.client.send('CardReader', 'PING');
    harness.bus.failWorkerScripts();
    await sent;
    await harness.settle();

    expect(device.writtenText()).toBe('PING');
    expect(device.written).toHaveLength(1);
  });
});

/**
 * A worker script of another protocol version: a copied worker file that was not replaced with the
 * library, or one served from a cache (ADR-0007).
 *
 * Such a worker drops everything the tabs say. It answers `hello` with a welcome in its own
 * version, which tells a tab that nothing it sent arrived anywhere - as when the script does not
 * load at all.
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
    const { harness } = readerHarness({ transport: 'sharedworker', logger });
    const owner = harness.openTab();
    await owner.setup('CardReader', READER_OPTIONS);
    const other = harness.openTab();
    await other.setup('CardReader', READER_OPTIONS);
    await harness.settle();

    // Deployed again under the same worker URL while the tabs stayed open. The welcome of this
    // version came long ago, so there is nothing left to fall back from, and every worker started
    // from that URL runs the new script: only a reload helps (ADR-0007).
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
