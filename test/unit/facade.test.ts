import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { SerialBroker } from '../../src/facade.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
import { flushMicrotasks } from '../harness/fake-clock.js';
import { FakeLockManager } from '../harness/fake-locks.js';
import { FakeSerialRegistry, type FakeDevice } from '../harness/fake-serial.js';
import { fieldsOfEvent, recordingLogger } from '../harness/recording-logger.js';

/**
 * The zero-argument singleton an application actually imports.
 *
 * It is thin by design - it builds the environment lazily and delegates - but "thin" is not
 * "correct": the lazy construction, the global options, and the fact that merely importing
 * the module must not touch a global are all behaviour worth pinning down.
 */

/**
 * Puts the harness's Web Serial and Web Locks fakes where a browser puts the real ones.
 *
 * The rest of the suite injects its environment (ADR-0014), but the singleton builds its own
 * from globals on first use - so the same fakes a harness tab is wired to are installed as
 * `navigator.serial` and `navigator.locks`, for one page with one granted device. Everything
 * else is stubbed only as far as building an environment needs: without `SharedWorker` the
 * facade takes the `BroadcastChannel` path, with nobody else on the channel.
 */
function stubPlatform(): { serial: FakeSerialRegistry; device: FakeDevice } {
  const serial = new FakeSerialRegistry();
  const device = serial.addDevice(READER.vendorId, READER.productId);
  serial.grant(device);

  vi.stubGlobal('navigator', {
    serial: serial.forContext('page'),
    locks: new FakeLockManager().forContext('page'),
  });

  vi.stubGlobal('SharedWorker', undefined);
  vi.stubGlobal(
    'BroadcastChannel',
    class {
      postMessage = (): void => undefined;
      close = (): void => undefined;
      addEventListener = (): void => undefined;
    },
  );

  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, value),
    removeItem: (key: string) => entries.delete(key),
  });

  return { serial, device };
}

/** Lets the library's promise chains run, as `BrowserHarness.settle()` does. */
async function settle(): Promise<void> {
  await flushMicrotasks(8);
}

describe('SerialBroker', () => {
  let platform: ReturnType<typeof stubPlatform>;

  beforeEach(() => {
    platform = stubPlatform();
  });

  afterEach(async () => {
    await SerialBroker.dispose();
    // `configure()` merges, so `configure({})` would leave a test's logger in place for every
    // later test. Overwriting the fields a test may set is the only reset the facade offers.
    SerialBroker.configure({ logger: { log: () => undefined }, logPayloads: false });
    vi.unstubAllGlobals();
  });

  it('reports whether the platform can support it', () => {
    expect(SerialBroker.isSupported()).toBe(true);
  });

  it('connects, sends and receives through the singleton', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await settle();

    const received: string[] = [];
    SerialBroker.subscribe('Reader', 'onReceive', (event) => {
      received.push(new TextDecoder().decode(event.data));
    });

    await SerialBroker.send('Reader', 'PING');
    platform.device.emit('PONG');
    await settle();

    expect(SerialBroker.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(new TextDecoder().decode(platform.device.written[0])).toBe('PING');
    expect(received).toEqual(['PONG']);
  });

  it('answers questions about what is set up', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);

    expect(SerialBroker.exists('Reader')).toBe(true);
    expect(SerialBroker.exists('Other')).toBe(false);
    expect(SerialBroker.names()).toEqual(['Reader']);
  });

  it('removes a listener through the returned function and through unsubscribe', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await settle();
    const viaReturn = vi.fn();
    const viaName = vi.fn();
    const kept = vi.fn();

    const stop = SerialBroker.subscribe('Reader', 'onReceive', viaReturn);
    SerialBroker.subscribe('Reader', 'onReceive', viaName);
    SerialBroker.subscribe('Reader', 'onReceive', kept);
    stop();
    SerialBroker.unsubscribe('Reader', 'onReceive', viaName);

    platform.device.emit('x');
    await settle();

    // The listener left in place proves the chunk was delivered at all.
    expect(kept).toHaveBeenCalledOnce();
    expect(viaReturn).not.toHaveBeenCalled();
    expect(viaName).not.toHaveBeenCalled();
  });

  it('releases everything it holds', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await settle();

    expect(platform.device.isOpen).toBe(true);

    await SerialBroker.releaseAll();

    expect(SerialBroker.names()).toEqual([]);
    expect(platform.device.isOpen).toBe(false);
  });

  it('restores a configuration persisted earlier', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await settle();
    await SerialBroker.dispose();

    await expect(SerialBroker.restore()).resolves.toEqual(['Reader']);
  });

  it('grants access when the user picks the configured device', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await settle();
    platform.serial.pickerQueue.push(platform.device);

    await expect(SerialBroker.requestAccess('Reader')).resolves.toBe(true);
  });

  it('rejects an operation on a configuration that is not set up', () => {
    expect(() => SerialBroker.getStatus('Nothing')).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.UNKNOWN_CONFIGURATION }),
    );
  });

  it('passes a configured logger through to the library', async () => {
    const { logger, records } = recordingLogger();

    SerialBroker.configure({ logger });
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await settle();

    expect(fieldsOfEvent(records, 'client.setup')).toEqual([
      expect.objectContaining({ configName: 'Reader' }),
    ]);
    // Every record carries the fields that let several tabs be correlated in one console.
    for (const [, , fields] of records) {
      expect(fields).toHaveProperty('clientId');
    }
  });

  it('warns when configure() comes too late to reach the client, and applies it after dispose()', async () => {
    const first = recordingLogger();
    const second = recordingLogger();

    SerialBroker.configure({ logger: first.logger });
    await SerialBroker.setup('Reader', READER_OPTIONS);
    SerialBroker.configure({ logger: second.logger });

    // The warning goes to the logger in use: the new one has not reached anything yet.
    expect(fieldsOfEvent(first.records, 'facade.late-configure')).toEqual([
      expect.objectContaining({ options: 'logger' }),
    ]);

    await SerialBroker.dispose();
    await SerialBroker.setup('Reader', READER_OPTIONS);

    expect(fieldsOfEvent(second.records, 'client.setup')).toHaveLength(1);
  });

  it('passes logPayloads through, so traffic records carry the bytes', async () => {
    const { logger, records } = recordingLogger();

    SerialBroker.configure({ logger, logPayloads: true });
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await settle();
    platform.device.emit('PONG');
    await settle();

    expect(fieldsOfEvent(records, 'supervisor.received')[0]).toMatchObject({
      byteLength: 4,
      hex: '50 4F 4E 47',
    });
  });

  it('answers what is set up without building anything, even without Web Serial', async () => {
    await SerialBroker.dispose();
    vi.stubGlobal('navigator', {});

    expect(SerialBroker.exists('Reader')).toBe(false);
    expect(SerialBroker.names()).toEqual([]);
    await expect(SerialBroker.release('Reader')).resolves.toBeUndefined();
    await expect(SerialBroker.releaseAll()).resolves.toBeUndefined();
  });

  it('removes a listener without building anything, even without Web Serial', async () => {
    await SerialBroker.dispose();
    vi.stubGlobal('navigator', {});
    const listener = vi.fn();

    expect(() => {
      SerialBroker.unsubscribe('Reader', 'onReceive', listener);
    }).not.toThrow();
    // The name is still checked, exactly as it would be with a client.
    expect(() => {
      SerialBroker.unsubscribe('', 'onReceive', listener);
    }).toThrow(expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT }));
    // A call that does need a client still builds one, and says why it cannot.
    expect(() => SerialBroker.getStatus('Reader')).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE }),
    );
  });

  it('rebuilds itself after being disposed', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await SerialBroker.dispose();

    await SerialBroker.setup('Reader', READER_OPTIONS);

    expect(SerialBroker.exists('Reader')).toBe(true);
  });

  describe('misuse', () => {
    const invalidArgument = (argumentName: string): unknown => {
      const context: unknown = expect.objectContaining({ argumentName });
      return expect.objectContaining({ code: SerialBrokerErrorCode.INVALID_ARGUMENT, context });
    };

    it('rejects release options that are not an object, and keeps the configuration running', async () => {
      await SerialBroker.setup('Reader', READER_OPTIONS);
      await settle();

      await expect(SerialBroker.release('Reader', null as never)).rejects.toThrow(
        invalidArgument('options'),
      );
      await expect(SerialBroker.releaseAll(null as never)).rejects.toThrow(
        invalidArgument('options'),
      );

      expect(SerialBroker.exists('Reader')).toBe(true);
      expect(platform.device.isOpen).toBe(true);
    });

    it('rejects a forgetDevice that is not a boolean rather than keeping the permission silently', async () => {
      await SerialBroker.setup('Reader', READER_OPTIONS);
      await settle();

      await expect(
        SerialBroker.release('Reader', { forgetDevice: 'yes' } as never),
      ).rejects.toThrow(invalidArgument('options.forgetDevice'));
      expect(SerialBroker.exists('Reader')).toBe(true);
    });

    it('checks release options also when nothing is set up', async () => {
      await expect(SerialBroker.release('Reader', 7 as never)).rejects.toThrow(
        invalidArgument('options'),
      );
    });

    it('gives the errors of its own checks the time they arose, with or without a client', async () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
      const atThatTime: unknown = expect.objectContaining({
        code: SerialBrokerErrorCode.INVALID_ARGUMENT,
        timestamp: 1_700_000_000_000,
      });
      try {
        expect(() => {
          SerialBroker.configure(null as never);
        }).toThrow(atThatTime);
        expect(() => {
          SerialBroker.unsubscribe(42 as never, 'onReceive', () => undefined);
        }).toThrow(atThatTime);
        await expect(SerialBroker.release('Reader', 7 as never)).rejects.toThrow(atThatTime);
        await expect(SerialBroker.releaseAll(7 as never)).rejects.toThrow(atThatTime);

        await SerialBroker.setup('Reader', READER_OPTIONS);
        await expect(SerialBroker.release('Reader', 7 as never)).rejects.toThrow(atThatTime);
      } finally {
        now.mockRestore();
      }
    });

    it('acts on forgetDevice as it was when release() was called, not once the port has closed', async () => {
      await SerialBroker.setup('Reader', READER_OPTIONS);
      await settle();
      const options = { forgetDevice: false };

      const released = SerialBroker.release('Reader', options);
      // An application reusing one options object for its next call.
      options.forgetDevice = true;
      await released;

      // Released without forgetting: the permission is still there.
      await expect(platform.serial.forContext('page').getPorts()).resolves.toHaveLength(1);
    });

    it('rejects library-wide options of the wrong type, so a truthy string cannot log payloads', () => {
      expect(() => {
        SerialBroker.configure({ logPayloads: 'yes' } as never);
      }).toThrow(invalidArgument('options.logPayloads'));
      expect(() => {
        SerialBroker.configure(null as never);
      }).toThrow(invalidArgument('options'));
      expect(() => {
        SerialBroker.configure({ transport: 'websocket' } as never);
      }).toThrow(invalidArgument('options.transport'));
      expect(() => {
        SerialBroker.configure({ workerUrl: 42 } as never);
      }).toThrow(invalidArgument('options.workerUrl'));
      expect(() => {
        // A logging function where an object with a `log` method belongs.
        SerialBroker.configure({ logger: () => undefined } as never);
      }).toThrow(invalidArgument('options.logger'));
    });

    it('keeps no part of library-wide options that failed validation', async () => {
      const { logger, records } = recordingLogger();

      expect(() => {
        SerialBroker.configure({ logger, logPayloads: 'yes' } as never);
      }).toThrow();
      await SerialBroker.setup('Reader', READER_OPTIONS);
      await settle();

      expect(records).toEqual([]);
    });

    it('reads library-wide options once, when configure() is called', async () => {
      const { logger, records } = recordingLogger();
      let reads = 0;
      const options = {
        logger,
        get logPayloads() {
          reads += 1;
          return reads === 1 ? false : 'yes';
        },
      };

      SerialBroker.configure(options as never);
      await SerialBroker.setup('Reader', READER_OPTIONS);
      await settle();
      platform.device.emit('PIN 1234');
      await settle();

      expect(reads).toBe(1);
      expect(fieldsOfEvent(records, 'supervisor.received')[0]).not.toHaveProperty('hex');
    });

    it('takes options declared as getters on a class, which spreading the object would lose', async () => {
      const { logger, records } = recordingLogger();
      class Settings {
        get logger(): typeof logger {
          return logger;
        }
      }

      SerialBroker.configure(new Settings());
      await SerialBroker.setup('Reader', READER_OPTIONS);

      expect(records.length).toBeGreaterThan(0);
    });

    it('resolves a release made while dispose() runs only once the port is closed', async () => {
      await SerialBroker.setup('Reader', READER_OPTIONS);
      await settle();
      expect(platform.device.isOpen).toBe(true);

      const disposing = SerialBroker.dispose();
      const released = SerialBroker.release('Reader');
      const releasedAll = SerialBroker.releaseAll();
      const disposedAgain = SerialBroker.dispose();

      await released;
      expect(platform.device.isOpen).toBe(false);
      await releasedAll;
      await disposedAgain;
      await disposing;
      expect(platform.device.isOpen).toBe(false);
    });
  });
});
