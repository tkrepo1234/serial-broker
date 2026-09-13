import { describe, expect, it } from 'vitest';

import { copyBytes } from '../../src/core/bytes.js';
import { DisposalStack } from '../../src/core/disposable.js';
import { EventEmitter } from '../../src/core/emitter.js';
import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { describeUnknown, isSerializedError, SerialBrokerError } from '../../src/core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { normalizeConfiguration, validateName } from '../../src/core/validation.js';
import type { KeyValueStorage } from '../../src/environment/environment.js';
import { ConfigurationStore, storageKey } from '../../src/storage/configuration-store.js';
import { BrowserHarness } from '../harness/browser-harness.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';

/**
 * Defects found in the bug hunt of 2026-09-13 (second round), each pinned by the behaviour it broke.
 */

describe('text encoding labels', () => {
  it('keeps the canonical name, so strings can be sent whatever the label was spelled like', async () => {
    const harness = new BrowserHarness();
    const device = harness.serial.addDevice(READER.vendorId, READER.productId);
    harness.serial.grant(device);
    const tab = harness.openTab();
    await tab.setup('Reader', { ...READER_OPTIONS, encoding: { encoding: 'UTF8' } });

    await tab.client.send('Reader', 'PING');
    await harness.settle();

    expect(new TextDecoder().decode(device.written[0])).toBe('PING');
    expect(
      normalizeConfiguration('x', { ...READER_OPTIONS, encoding: { encoding: 'Latin1' } }),
    ).toMatchObject({ encoding: { encoding: 'windows-1252' } });
  });
});

describe('configuration names', () => {
  it('rejects C1 control characters and unpaired surrogates, which would corrupt lock names', () => {
    for (const name of ['a0085b', 'a\uD800', '\uDC00a', 'a\uDC00\uD800']) {
      expect(() => validateName(name)).toThrow(
        expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT }),
      );
    }
    expect(validateName('Scale 🎚️')).toBe('Scale 🎚️');
  });
});

describe('copying payload bytes', () => {
  it('accepts an ArrayBuffer from another realm', async () => {
    const { runInNewContext } = await import('node:vm');
    const foreign = runInNewContext('new Uint8Array([1, 2, 3]).buffer') as ArrayBuffer;

    expect([...copyBytes(foreign)]).toEqual([1, 2, 3]);
  });

  it('copies a view of shared memory into memory of its own', () => {
    const shared = new Uint8Array(new SharedArrayBuffer(4));
    shared.set([1, 2, 3, 4]);

    const copy = copyBytes(shared.subarray(1, 3) as unknown as BufferSource);

    expect(copy.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...copy]).toEqual([2, 3]);
  });

  it('reports a view of a transferred buffer as a serial-broker error', () => {
    const buffer = new ArrayBuffer(4);
    const view = new Uint8Array(buffer, 1, 2);
    structuredClone(buffer, { transfer: [buffer] });

    expect(() => copyBytes(view)).toThrow(
      expect.objectContaining({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
        context: expect.objectContaining({ detached: true }) as unknown,
      }),
    );
  });
});

describe('reporting hostile errors', () => {
  it('describes an error whose name is a Symbol or whose message getter throws', () => {
    const symbolName = Object.assign(new Error('x'), { name: Symbol('odd') as unknown as string });
    const throwing = new Error('x');
    Object.defineProperty(throwing, 'message', {
      get: () => {
        throw new Error('no');
      },
    });

    expect(describeUnknown(symbolName)).toBe('Symbol(odd): x');
    expect(describeUnknown(throwing)).toBe('[object Error]');
  });

  it('still delivers the event to later listeners when a listener throws such an error', () => {
    const reported: SerialBrokerError[] = [];
    const emitter = new EventEmitter(
      (error) => reported.push(error),
      () => 0,
    );
    const later: unknown[] = [];
    emitter.add('onStatusChange', () => {
      throw Object.assign(new Error('x'), { name: Symbol('odd') as unknown as string });
    });
    emitter.add('onStatusChange', (event) => later.push(event));

    emitter.emit('onStatusChange', {
      name: 'Reader',
      status: 'open',
      previousStatus: 'connecting',
      timestamp: 0,
    });

    expect(later).toHaveLength(1);
    expect(reported.map((error) => error.code)).toEqual([SerialBrokerErrorCode.LISTENER_THREW]);
  });

  it('rejects a serialized error whose configName is not a string', () => {
    const serialized = new SerialBrokerError(SerialBrokerErrorCode.WRITE_FAILED, 'x').toJSON();

    expect(isSerializedError({ ...serialized, configName: { evil: true } })).toBe(false);
    expect(isSerializedError({ ...serialized, configName: 'Reader' })).toBe(true);
  });
});

describe('disposal', () => {
  it('reports a failure of a disposer registered while disposing, in the same call', () => {
    const stack = new DisposalStack();
    stack.add(() => {
      stack.add(() => {
        throw new Error('late');
      });
    });

    expect(stack.disposeAll()).toEqual(['Error: late']);
  });
});

describe('remembered configurations', () => {
  function stored(...names: string[]): string {
    return JSON.stringify(
      Object.fromEntries(
        names.map((name) => [name, { device: READER, serial: { baudRate: 9600 } }]),
      ),
    );
  }

  it('removes an entry left behind when the same name is set up without being remembered', async () => {
    const harness = new BrowserHarness();
    harness.storage.poison(storageKey(), stored('Reader'));
    const tab = harness.openTab();

    await tab.setup('Reader', { ...READER_OPTIONS, persist: false });
    await tab.close();

    await expect(harness.openTab().client.restore()).resolves.toEqual([]);
  });

  it('removes an invalid entry once instead of reporting it on every restore', () => {
    const storage = new Map<string, string>([
      [
        storageKey(),
        JSON.stringify({
          Broken: { device: { vendorId: 'no' }, serial: { baudRate: 9600 } },
          Reader: { device: READER, serial: { baudRate: 9600 } },
        }),
      ],
    ]);
    const reported: SerialBrokerError[] = [];
    const store = new ConfigurationStore(mapStorage(storage), silentLogger(), (error) =>
      reported.push(error),
    );

    expect(store.load().map((configuration) => configuration.name)).toEqual(['Reader']);
    expect(store.load().map((configuration) => configuration.name)).toEqual(['Reader']);

    expect(reported.map((error) => error.code)).toEqual([SerialBrokerErrorCode.STORAGE_CORRUPT]);
    expect(storage.get(storageKey())).not.toContain('Broken');
  });

  it('keeps configurations from an earlier key when moving them to the current key fails', () => {
    const legacy = stored('Old');
    const storage = new Map<string, string>([['serial-broker/v4/configurations', legacy]]);
    const quota: KeyValueStorage = {
      ...mapStorage(storage),
      setItem: (key, value) => {
        if (value === legacy) {
          throw new DOMException('quota', 'QuotaExceededError');
        }
        storage.set(key, value);
      },
    };
    const store = new ConfigurationStore(quota, silentLogger(), () => undefined);

    expect(store.load().map((configuration) => configuration.name)).toEqual(['Old']);
    store.save(normalizeConfiguration('New', { device: READER, serial: { baudRate: 9600 } }));

    // The write that succeeded carried the old configuration along instead of replacing it.
    expect(
      store
        .load()
        .map((configuration) => configuration.name)
        .sort(),
    ).toEqual(['New', 'Old']);
  });
});

function mapStorage(entries: Map<string, string>): KeyValueStorage {
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function silentLogger(): ScopedLogger {
  return new ScopedLogger(NOOP_LOGGER, {});
}
