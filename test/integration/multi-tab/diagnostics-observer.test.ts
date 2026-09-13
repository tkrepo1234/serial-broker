import { describe, expect, it } from 'vitest';

import type { DiagnosticsObserver } from '../../../src/client/diagnostics-observer.js';
import type {
  ConfigurationDiagnostics,
  DiagnosticsSnapshot,
  ObservedEvent,
} from '../../../src/core/diagnostics.js';
import { SerialBrokerErrorCode } from '../../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../../src/core/types.js';
import { ownerLockName } from '../../../src/protocol/version.js';
import { BrowserHarness, TRANSPORT_MODES } from '../../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../../harness/devices.js';

const WINDOW_MS = 100;

/**
 * Looking at every tab of an origin without taking part (ADR-0018).
 *
 * Two properties matter above the details of any report. An observer must see what ADR-0011
 * keeps from the application - roles, the owner's connection, pending writes - on both
 * transports. And observing must never change what is observed: an observer that could end up
 * owning the port would move it the moment the application's tabs closed.
 */
describe.each(TRANSPORT_MODES)('diagnostics observer (%s)', (transport) => {
  async function twoTabsSharingAPort(): Promise<{
    harness: BrowserHarness;
    device: ReturnType<BrowserHarness['serial']['addDevice']>;
    owner: ReturnType<BrowserHarness['openTab']>;
    peer: ReturnType<BrowserHarness['openTab']>;
  }> {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);
    return { harness, device, owner, peer };
  }

  /** Runs one collection to the end of its window. */
  async function collect(
    harness: BrowserHarness,
    observer: DiagnosticsObserver,
  ): Promise<DiagnosticsSnapshot> {
    const pending = observer.collect(WINDOW_MS);
    // Replies travel as messages; they arrive before the window closes, not because of it.
    await harness.settle();
    await harness.advance(WINDOW_MS);
    return await pending;
  }

  function reportOf(
    snapshot: DiagnosticsSnapshot,
    tab: { client: { clientId: string } },
    name = 'Reader',
  ): ConfigurationDiagnostics | undefined {
    return snapshot.participants
      .find((participant) => participant.clientId === tab.client.clientId)
      ?.configurations.find((configuration) => configuration.name === name);
  }

  it('hears from every tab with a configuration, with its role, status and effective settings', async () => {
    const { harness, owner, peer } = await twoTabsSharingAPort();
    harness.openTab(); // never set anything up, so it is not on the bus
    const observer = harness.openObserver();

    const snapshot = await collect(harness, observer);

    expect(snapshot.participants).toHaveLength(2);
    expect(snapshot.participants.every((participant) => participant.transport === transport)).toBe(
      true,
    );
    expect(reportOf(snapshot, owner)).toMatchObject({
      role: 'owner',
      status: SerialBrokerStatus.Open,
      settings: {
        device: READER,
        serial: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
        connection: { writeTimeoutMs: 5_000, maxAttempts: Number.POSITIVE_INFINITY },
        persist: true,
      },
    });
    expect(reportOf(snapshot, peer)).toMatchObject({
      role: 'participant',
      status: SerialBrokerStatus.Open,
    });
    expect(reportOf(snapshot, peer)?.connection).toBeUndefined();
  });

  it('describes the owner connection, with the bytes that went each way', async () => {
    const { harness, device, owner } = await twoTabsSharingAPort();
    const observer = harness.openObserver();

    await owner.client.send('Reader', 'PING');
    device.emit('PONG!');
    await harness.settle();
    const snapshot = await collect(harness, observer);

    expect(reportOf(snapshot, owner)?.connection).toMatchObject({
      state: 'open',
      bytesSent: 4,
      bytesReceived: 5,
      queuedWrites: 0,
      nextAttemptAt: undefined,
    });
    expect(reportOf(snapshot, owner)?.connection?.openedAt).toBeTypeOf('number');
  });

  it('says when the owner will next try to reconnect', async () => {
    const harness = new BrowserHarness({ transport });
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    device.faults.failOpenWith = 'NetworkError';
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const observer = harness.openObserver();

    // The first retry is immediate and fails as well, so the second is scheduled after the
    // initial delay: 250 ms, with the harness's jitter draw fixed at the top of the range.
    await harness.advance(0);
    const scheduledAt = harness.clock.now();
    const snapshot = await collect(harness, observer);

    expect(reportOf(snapshot, tab)).toMatchObject({
      status: SerialBrokerStatus.Reconnecting,
      // What the platform's NetworkError on open() maps to (owner/serial-errors.ts).
      lastErrorCode: SerialBrokerErrorCode.DEVICE_DISCONNECTED,
      connection: { state: 'reconnecting', attempt: 2, nextAttemptAt: scheduledAt + 250 },
    });
  });

  it('shows a write that is waiting on a device, both where it was issued and at the port', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();
    const observer = harness.openObserver();
    device.faults.hangOnWrite = true;

    const outcome = peer.client.send('Reader', 'STUCK').catch((reason: unknown) => reason);
    await harness.settle();
    const snapshot = await collect(harness, observer);

    expect(reportOf(snapshot, peer)?.pendingWrites).toEqual({
      total: 1,
      dispatched: 1,
      started: 1,
    });
    expect(reportOf(snapshot, owner)?.connection?.queuedWrites).toBe(1);

    await harness.advance(10_000);
    expect(await outcome).toMatchObject({ code: SerialBrokerErrorCode.WRITE_TIMEOUT });
  });

  it('counts the listeners each tab has registered', async () => {
    const { harness, owner } = await twoTabsSharingAPort();
    const observer = harness.openObserver();

    owner.client.subscribe('Reader', 'onReceive', () => undefined);
    const snapshot = await collect(harness, observer);

    // The harness records every event, so each already has one listener of its own.
    expect(reportOf(snapshot, owner)?.listeners).toEqual({
      onReceive: 2,
      onSend: 1,
      onError: 1,
      onStatusChange: 1,
    });
  });

  it('reports every configuration a tab has set up', async () => {
    const { harness, owner } = await twoTabsSharingAPort();
    harness.serial.grant(harness.serial.addDevice(0x0403, 0x6001));
    await owner.setup('Scale', { device: { any: true }, serial: { baudRate: 19_200 } });
    const observer = harness.openObserver();

    const snapshot = await collect(harness, observer);

    expect(reportOf(snapshot, owner, 'Scale')?.settings).toMatchObject({
      device: { any: true },
      serial: { baudRate: 19_200 },
    });
  });

  it('lists who holds the ownership lock and who is queued behind it', async () => {
    const { harness, owner, peer } = await twoTabsSharingAPort();
    const observer = harness.openObserver();

    const snapshot = await collect(harness, observer);

    expect(snapshot.locks?.held).toEqual([
      { name: ownerLockName('Reader'), mode: 'exclusive', browserClientId: owner.id },
    ]);
    expect(snapshot.locks?.pending).toEqual([
      { name: ownerLockName('Reader'), mode: 'exclusive', browserClientId: peer.id },
    ]);
  });

  it('never joins the election, so a port nobody else wants stays with nobody', async () => {
    const harness = new BrowserHarness({ transport });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);
    const observer = harness.openObserver();
    observer.watch('Reader', () => undefined);
    await collect(harness, observer);

    await tab.close();

    expect(harness.locks.holderOf(ownerLockName('Reader'))).toBeUndefined();
    expect(harness.locks.queueLength(ownerLockName('Reader'))).toBe(0);
  });

  it('streams traffic, and the handover when the owning tab is killed', async () => {
    const { harness, device, owner, peer } = await twoTabsSharingAPort();
    const observer = harness.openObserver();
    const events: ObservedEvent[] = [];
    observer.watch('Reader', (event) => events.push(event));
    await harness.settle();

    device.emit('HELLO');
    await peer.client.send('Reader', 'X');
    await harness.settle();
    await owner.kill();

    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'received', from: owner.client.clientId, text: undefined }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'sent', originClientId: peer.client.clientId }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'owner-claimed', from: peer.client.clientId }),
    );
  });

  it('stops streaming once the last listener unsubscribes', async () => {
    const { harness, device } = await twoTabsSharingAPort();
    const observer = harness.openObserver();
    const events: ObservedEvent[] = [];
    const stop = observer.watch('Reader', (event) => events.push(event));
    await harness.settle();

    stop();
    stop();
    await harness.settle();
    device.emit('UNSEEN');
    await harness.settle();

    expect(events).toEqual([]);
  });

  it('keeps delivering to other listeners when one of them throws', async () => {
    const { harness, device } = await twoTabsSharingAPort();
    const observer = harness.openObserver();
    const events: ObservedEvent[] = [];
    observer.watch('Reader', () => {
      throw new Error('a broken diagnostics view');
    });
    observer.watch('Reader', (event) => events.push(event));
    await harness.settle();

    device.emit('STILL-DELIVERED');
    await harness.settle();

    expect(events.map((event) => event.kind)).toContain('received');
  });

  it('ends a collection early, with what arrived, when the observer is closed', async () => {
    const { harness } = await twoTabsSharingAPort();
    const observer = harness.openObserver();

    const pending = observer.collect(60_000);
    await harness.settle();
    observer.close();
    const snapshot = await pending;

    expect(snapshot.participants).toHaveLength(2);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });

  it('refuses to be used after it is closed, and refuses a nonsensical window', async () => {
    const { harness } = await twoTabsSharingAPort();
    const observer = harness.openObserver();

    await expect(observer.collect(-1)).rejects.toMatchObject({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
    });
    observer.close();
    observer.close();

    await expect(observer.collect()).rejects.toMatchObject({
      code: SerialBrokerErrorCode.CONFIGURATION_RELEASED,
    });
    expect(() => observer.watch('Reader', () => undefined)).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.CONFIGURATION_RELEASED }),
    );
  });

  it('ends up on the same transport as the tabs, and each report names the one its tab uses', async () => {
    const { harness, owner, peer } = await twoTabsSharingAPort();
    const observer = harness.openObserver();

    const snapshot = await collect(harness, observer);

    expect(observer.transportKind).toBe(transport);
    expect(snapshot.participants.map((participant) => participant.transport)).toEqual([
      owner.client.transportKind,
      peer.client.transportKind,
    ]);
  });

  it('never appears among the participants it reports on', async () => {
    const { harness } = await twoTabsSharingAPort();
    const observer = harness.openObserver();

    const snapshot = await collect(harness, observer);

    expect(snapshot.observerClientId).toBe(observer.clientId);
    expect(snapshot.participants.map((participant) => participant.clientId)).not.toContain(
      observer.clientId,
    );
  });
});
