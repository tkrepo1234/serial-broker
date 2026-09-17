import { describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { SerialBrokerError } from '../../src/core/errors.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import * as publicApi from '../../src/index.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { connectedTab, READER_OPTIONS, readerHarness } from '../harness/devices.js';

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
    const { harness } = readerHarness();
    const owner = harness.openTab();
    await owner.setup('Reader', READER_OPTIONS);
    const peer = harness.openTab();
    await peer.setup('Reader', READER_OPTIONS);
    return { harness, owner, peer };
  }

  it('exposes exactly the documented status fields, the same in the owning tab and a peer', async () => {
    const { owner, peer } = await twoTabs();
    const ownerView = owner.client.getStatus('Reader');
    const peerView = peer.client.getStatus('Reader');

    expect(Object.keys(ownerView).sort()).toEqual([
      'deviceKind',
      'lastErrorCode',
      // This tab's own limit, not a count of tabs: it says whether `queued` is reachable at all,
      // and two tabs cannot run one configuration with different limits (CONFIGURATION_CONFLICT).
      'maxTabs',
      'name',
      'observedAt',
      'productId',
      'serialOptions',
      'since',
      'status',
      'vendorId',
    ]);
    // If these differed in any field, an application could work out which tab owns the port
    // and start branching on it - and then be wrong, because it changes without warning.
    expect(peerView.status).toBe(ownerView.status);
    expect(Object.keys(peerView)).toEqual(Object.keys(ownerView));
  });

  it('exposes exactly the documented receive payload', async () => {
    const { harness, device } = readerHarness();
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

  it('keeps diagnostics out of the main entry point', () => {
    // Diagnostics reveal exactly what this boundary withholds, so they live behind an entry point
    // of their own, where code has to reach for them on purpose (ADR-0018).
    const exported = Object.keys(publicApi).map((key) => key.toLowerCase());

    expect(exported.some((key) => key.includes('diagnostic') || key.includes('observer'))).toBe(
      false,
    );
  });

  it('reports a status an application can act on, with no coordination vocabulary in it', () => {
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

  it('checks release options in the client itself, and keeps the configuration running', async () => {
    const { harness, device } = readerHarness();
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);
    await harness.settle();
    const invalid = expect.objectContaining({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
      context: expect.objectContaining({ argumentName: 'options.forgetDevice' }) as unknown,
    }) as unknown;

    // The debugging surface calls the client directly, past the facade's checks.
    await expect(tab.client.release('Reader', { forgetDevice: 'yes' } as never)).rejects.toThrow(
      invalid,
    );
    await expect(tab.client.releaseAll({ forgetDevice: 1 } as never)).rejects.toThrow(invalid);
    await expect(
      tab.client.release('Nonexistent', { forgetDevice: 'yes' } as never),
    ).rejects.toThrow(invalid);

    // The same for `forget`, which decides whether the remembered configuration survives: a value
    // that is not a boolean must not be read as either answer.
    const invalidForget = expect.objectContaining({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
      context: expect.objectContaining({ argumentName: 'options.forget' }) as unknown,
    }) as unknown;
    await expect(tab.client.release('Reader', { forget: 'yes' } as never)).rejects.toThrow(
      invalidForget,
    );
    await expect(tab.client.releaseAll({ forget: 1 } as never)).rejects.toThrow(invalidForget);

    expect(tab.client.exists('Reader')).toBe(true);
    expect(device.isOpen).toBe(true);
  });

  it('refuses a payload larger than the bus carries in every tab, the one holding the port included', async () => {
    const { harness, owner, peer } = await (async () => {
      const { harness } = readerHarness();
      const owner = harness.openTab();
      await owner.client.setup('Reader', READER_OPTIONS);
      await harness.settle();
      const peer = harness.openTab();
      await peer.client.setup('Reader', READER_OPTIONS);
      await harness.settle();
      return { harness, owner, peer };
    })();
    const tooLarge = new Uint8Array(16 * 1024 * 1024 + 1);
    const refused = expect.objectContaining({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
      context: expect.objectContaining({
        argumentName: 'data',
        byteLength: tooLarge.byteLength,
      }) as unknown,
    }) as unknown;

    // Otherwise the tab holding the port would write it, and another tab's request would be dropped
    // on the bus and time out: whether it works would depend on which tab holds the port.
    await expect(owner.client.send('Reader', tooLarge)).rejects.toThrow(refused);
    await expect(peer.client.send('Reader', tooLarge)).rejects.toThrow(refused);
    await expect(
      peer.client.send('Reader', new Uint8Array(16 * 1024 * 1024)),
    ).resolves.toBeUndefined();
    await harness.settle();
  });

  it('treats a repeated setup with equal options as a no-op', async () => {
    const { harness, device } = readerHarness();
    const tab = harness.openTab();

    await tab.client.setup('Reader', READER_OPTIONS);
    await harness.settle();
    await tab.client.setup('Reader', READER_OPTIONS);
    await harness.settle();

    // Safe to call on every page initialisation, and it must not interrupt a working port.
    expect(device.openCount).toBe(1);
  });

  it('refuses a setup that would reopen the port differently', async () => {
    const { harness } = readerHarness();
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);

    await expect(
      tab.client.setup('Reader', { ...READER_OPTIONS, serial: { baudRate: 19_200 } }),
    ).rejects.toMatchObject({ code: SerialBrokerErrorCode.CONFIGURATION_CONFLICT });
  });

  it('conflicts when only the buffer size differs, since the port opens with it', async () => {
    const { tab } = await connectedTab();

    await expect(
      tab.client.setup('Reader', {
        ...READER_OPTIONS,
        serial: { baudRate: 9600, bufferSize: 4096 },
      }),
    ).rejects.toMatchObject({ code: SerialBrokerErrorCode.CONFIGURATION_CONFLICT });
  });

  it('returns an unsubscribe function that is safe to call twice', async () => {
    const { harness, device } = readerHarness();
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
    const { harness, device } = readerHarness();
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
});

async function thrown(action: () => unknown): Promise<SerialBrokerError> {
  try {
    await action();
  } catch (error) {
    return error as SerialBrokerError;
  }
  throw new Error('expected the action to throw');
}

describe('errors thrown at the public surface', () => {
  it('carry the time they reached the caller, not zero', async () => {
    const harness = new BrowserHarness();
    await harness.advance(12_345);
    const now = harness.clock.now();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    const errors = [
      await thrown(() => tab.client.setup('', READER_OPTIONS)),
      await thrown(() => tab.client.setup('Other', { ...READER_OPTIONS, maxTabs: 0 })),
      await thrown(() => tab.client.getStatus('')),
      await thrown(() => tab.client.send('Reader', 42 as never)),
      await thrown(() => tab.client.subscribe('Reader', 'onRecieve' as never, () => undefined)),
      await thrown(() => tab.client.subscribe('Reader', 'onReceive', 'not a function' as never)),
    ];

    for (const error of errors) {
      expect(error.code).toBe(SerialBrokerErrorCode.INVALID_ARGUMENT);
      expect(error.timestamp).toBe(now);
    }
  });

  it('describe an invalid argument alike, whichever check rejected it', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();
    await tab.setup('Reader', READER_OPTIONS);

    const event = await thrown(() =>
      tab.client.subscribe('Reader', 'onRecieve' as never, () => undefined),
    );
    const listener = await thrown(() =>
      tab.client.subscribe('Reader', 'onReceive', 'not a function' as never),
    );

    expect(event).toMatchObject({
      configName: 'Reader',
      context: { argumentName: 'event', actualType: 'string', actualValue: 'onRecieve' },
    });
    expect(listener).toMatchObject({
      configName: 'Reader',
      context: { argumentName: 'listener', expected: 'a function', actualType: 'string' },
    });
  });

  it('describe an invalid argument to the diagnostics observer alike, with its time', async () => {
    const harness = new BrowserHarness();
    await harness.advance(5_000);
    const observer = harness.openObserver();

    const window = await thrown(() => observer.collect(-1));
    const listener = await thrown(() => observer.watch('Reader', 42 as never));
    observer.close();

    expect(window).toMatchObject({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
      timestamp: harness.clock.now(),
      context: { argumentName: 'windowMs', expected: 'a non-negative integer', actualValue: -1 },
    });
    expect(listener).toMatchObject({
      timestamp: harness.clock.now(),
      context: { argumentName: 'listener', actualType: 'number' },
    });
  });
});

describe('argument validation at the boundary', () => {
  it('rejects an event name it does not know, rather than registering a listener never called', async () => {
    const { harness } = readerHarness();
    const tab = harness.openTab();
    await tab.client.setup('Reader', READER_OPTIONS);

    expect(() => tab.client.subscribe('Reader', 'onData' as never, vi.fn())).toThrow(
      expect.objectContaining({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
        context: expect.objectContaining({ argumentName: 'event' }) as unknown,
      }),
    );
    expect(tab.client.diagnostics()?.configurations[0]?.listeners).toEqual({
      onReceive: 0,
      onSend: 0,
      onError: 0,
      onStatusChange: 0,
    });
  });

  it('rejects an invalid name before doing anything with it', async () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();

    await expect(tab.client.send('', 'x')).rejects.toMatchObject({
      code: SerialBrokerErrorCode.INVALID_ARGUMENT,
    });
    expect(() => tab.client.exists(42 as never)).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT }),
    );
  });

  it('ignores unsubscribing from a configuration that is not set up', () => {
    const harness = new BrowserHarness();
    const tab = harness.openTab();

    expect(() => {
      tab.client.unsubscribe('Nothing', 'onReceive', vi.fn());
    }).not.toThrow();
  });
});
