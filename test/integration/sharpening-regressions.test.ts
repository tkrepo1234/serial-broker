import { describe, expect, it } from 'vitest';

import { SerialBrokerClient } from '../../src/client/serial-broker-client.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { SerialBrokerError } from '../../src/core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { ConfigurationStore, storageIndexKey } from '../../src/storage/configuration-store.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

/**
 * Findings of the sharpening of 2026-09-13 that cross module boundaries, each pinned by the
 * behaviour it broke.
 */

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

describe('storage problems', () => {
  it('are reported with the time they happened', () => {
    const entries = new Map([[storageIndexKey(), '{ not json']]);
    const reported: SerialBrokerError[] = [];
    const store = new ConfigurationStore(
      {
        getItem: (key) => entries.get(key) ?? null,
        setItem: (key, value) => entries.set(key, value),
        removeItem: (key) => entries.delete(key),
      },
      new ScopedLogger(NOOP_LOGGER, {}),
      (error) => reported.push(error),
      () => 777,
    );

    store.load();

    expect(reported.map((error) => [error.code, error.timestamp])).toEqual([
      [SerialBrokerErrorCode.STORAGE_CORRUPT, 777],
    ]);
  });
});

describe('disposing a client', () => {
  it('logs a cleanup step that failed instead of dropping it', async () => {
    const { logger, records } = recordingLogger();
    const harness = new BrowserHarness({ logger });
    const environment = harness.createEnvironment('page');
    const serial = environment.serial;
    const client = new SerialBrokerClient({
      ...environment,
      serial: {
        getPorts: () => serial.getPorts(),
        requestPort: (options) => serial.requestPort(options),
        addEventListener: (type, listener) => {
          serial.addEventListener(type, listener);
        },
        removeEventListener: () => {
          throw new Error('the platform refused');
        },
      },
    });
    harness.serial.grant(harness.serial.addDevice(READER.vendorId, READER.productId));
    await client.setup('Reader', READER_OPTIONS);

    await client.dispose();

    expect(fieldsOfEvent(records, 'client.dispose-failed')).toEqual([
      expect.objectContaining({
        reason: expect.stringContaining('the platform refused') as unknown,
      }),
    ]);
  });
});
