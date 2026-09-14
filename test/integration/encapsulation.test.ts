import { describe, expect, it } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import * as publicApi from '../../src/index.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/**
 * The encapsulation boundary, asserted rather than trusted.
 *
 * ADR-0011 says the public surface reveals nothing about how ownership is coordinated. That
 * is only true for as long as nobody adds a convenient field, and "convenient field" is
 * exactly how these things leak. So the shape is pinned here: an accidental addition fails
 * the suite rather than shipping and becoming load-bearing for somebody.
 */
describe('encapsulation', () => {
  async function twoTabs(): Promise<{
    harness: BrowserHarness;
    owner: ReturnType<BrowserHarness['openTab']>;
    peer: ReturnType<BrowserHarness['openTab']>;
  }> {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);
    return { harness, owner, peer };
  }

  it('exposes exactly the documented status fields', async () => {
    const { owner } = await twoTabs();

    expect(Object.keys(owner.client.getStatus('Reader')).sort()).toEqual([
      'lastErrorCode',
      'name',
      'observedAt',
      'productId',
      'serialOptions',
      'since',
      'status',
      'vendorId',
    ]);
  });

  it('gives the owning tab and a peer tab indistinguishable status snapshots', async () => {
    const { owner, peer } = await twoTabs();

    const ownerView = owner.client.getStatus('Reader');
    const peerView = peer.client.getStatus('Reader');

    // If these differed in any field, an application could work out which tab owns the port
    // and start branching on it - and then be wrong, because it changes without warning.
    expect(peerView.status).toBe(ownerView.status);
    expect(Object.keys(peerView)).toEqual(Object.keys(ownerView));
  });

  it('exposes exactly the documented receive payload', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    device.emit('x');
    await harness.settle();

    expect(Object.keys(tab.recordFor('Reader').received[0] ?? {}).sort()).toEqual([
      'data',
      'name',
      'text',
      'timestamp',
    ]);
  });

  it('exposes exactly the documented send payload, with no peer identity', async () => {
    const { harness, owner, peer } = await twoTabs();

    await peer.client.send('Reader', 'x');
    await harness.settle();

    const event = owner.recordFor('Reader').sent[0];
    expect(Object.keys(event ?? {}).sort()).toEqual(['data', 'name', 'origin', 'timestamp']);
    // `origin` says whether *this* tab issued the write. It deliberately does not say which
    // other tab did, because that is topology and nothing may depend on it.
    expect(event?.origin).toBe('remote');
  });

  it('exposes exactly the documented status-change payload', async () => {
    const { owner } = await twoTabs();

    expect(Object.keys(owner.recordFor('Reader').statuses[0] ?? {}).sort()).toEqual([
      'name',
      'previousStatus',
      'status',
      'timestamp',
    ]);
  });

  it('never returns a SerialPort to the application', async () => {
    const { owner } = await twoTabs();

    // Handing one out would let a tab close a port the others depend on and would break every
    // invariant the library maintains.
    const snapshot: Record<string, unknown> = { ...owner.client.getStatus('Reader') };
    for (const value of Object.values(snapshot)) {
      expect(typeof value === 'object' && value !== null && 'getInfo' in value).toBe(false);
    }
  });

  it('keeps diagnostics out of the main entry point', () => {
    // Diagnostics reveal exactly what this boundary withholds, so they live behind an entry point
    // of their own, where code has to reach for them on purpose (ADR-0018).
    const exported = Object.keys(publicApi).map((key) => key.toLowerCase());

    expect(exported.some((key) => key.includes('diagnostic') || key.includes('observer'))).toBe(
      false,
    );
  });

  it('reports a status an application can act on, with no coordination vocabulary in it', async () => {
    const { owner } = await twoTabs();
    const allStatuses: string[] = Object.values(SerialBrokerStatus);

    // `queued` says only that the tab limit the application itself set is reached (ADR-0025);
    // which tab holds the port stays unsayable.
    expect(allStatuses).toEqual([
      'idle',
      'queued',
      'awaiting-permission',
      'connecting',
      'open',
      'reconnecting',
      'failed',
      'released',
    ]);
    expect(allStatuses).not.toContain('owner');
    expect(owner.client.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
  });
});

describe('argument handling at the public surface', () => {
  it('rejects an unknown configuration by name, listing what is known', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);

    expect(() => tab.client.getStatus('Nonexistent')).toThrow(
      expect.objectContaining({
        code: SerialBrokerErrorCode.UNKNOWN_CONFIGURATION,
        configName: 'Nonexistent',
        context: { known: ['Reader'] },
      }),
    );
  });

  it('treats releasing an unknown configuration as a no-op', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();

    // It leaves the caller in the state they asked for, which is the definition of success.
    await expect(tab.client.release('Nonexistent')).resolves.toBeUndefined();
  });

  it('treats a repeated setup with equal options as a no-op', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();

    await tab.client.setup('Reader', READER_OPTIONS);
    await harness.settle();
    await tab.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // Safe to call on every page initialisation, and it must not interrupt a working port.
    expect(device.openCount).toBe(1);
  });

  it('refuses a setup that would reopen the port differently', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);

    await expect(
      tab.client.setup('Reader', { ...READER_OPTIONS, serial: { baudRate: 19_200 } }),
    ).rejects.toMatchObject({ code: SerialBrokerErrorCode.CONFIGURATION_CONFLICT });
  });

  it('returns an unsubscribe function that is safe to call twice', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);
    // `setup()` does not wait for the port: without this the chunk below reaches nobody, and the
    // assertion that nobody heard it passes for the wrong reason.
    await harness.settle();

    const received: unknown[] = [];
    const kept: unknown[] = [];
    const stop = tab.client.subscribe('Reader', 'onReceive', (event) => received.push(event));
    tab.client.subscribe('Reader', 'onReceive', (event) => kept.push(event));
    stop();
    stop();

    device.emit('x');
    await harness.settle();

    // The second call must not remove anything else, and the chunk did arrive.
    expect(kept).toHaveLength(1);
    expect(received).toHaveLength(0);
  });

  it('leaves a later registration of the same listener alone when an old unsubscribe runs', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    const received: unknown[] = [];
    const listener = (event: unknown): void => {
      received.push(event);
    };
    const stopFirst = tab.client.subscribe('Reader', 'onReceive', listener);
    stopFirst();
    tab.client.subscribe('Reader', 'onReceive', listener);
    // A component that unmounts late, holding the function of its first registration.
    stopFirst();

    const stopByName = tab.client.subscribe('Reader', 'onReceive', listener);
    tab.client.unsubscribe('Reader', 'onReceive', listener);
    tab.client.subscribe('Reader', 'onReceive', listener);
    stopByName();

    device.emit('x');
    await harness.settle();

    expect(received).toHaveLength(1);
  });

  it('lists the configurations set up in this tab', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    const tab = harness.openTab();

    await tab.client.setup('Reader', READER_OPTIONS);

    expect(tab.client.exists('Reader')).toBe(true);
    expect(tab.client.exists('Other')).toBe(false);
    expect(tab.client.names()).toEqual(['Reader']);
  });

  it('releases everything at once', async () => {
    const harness = new BrowserHarness();
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    harness.serial.grant(harness.serial.addDevice(0x0403, 0x6001));
    const tab = harness.openTab();

    await tab.client.setup('Reader', READER_OPTIONS);
    await tab.client.setup('Scale', {
      device: { vendorId: 0x0403, productId: 0x6001 },
      serial: { baudRate: 19_200 },
    });
    await tab.client.releaseAll();

    expect(tab.client.names()).toEqual([]);
    expect(harness.clock.pendingTimerCount).toBe(0);
  });
});
