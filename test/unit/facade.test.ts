import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { SerialBroker } from '../../src/serial-broker.js';
import { READER, READER_OPTIONS } from '../harness/devices.js';
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

/** Lets the library's promise chains run. */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('SerialBroker', () => {
  let platform: ReturnType<typeof stubPlatform>;

  beforeEach(() => {
    platform = stubPlatform();
  });

  afterEach(async () => {
    await SerialBroker.dispose();
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

    const stop = SerialBroker.subscribe('Reader', 'onReceive', viaReturn);
    SerialBroker.subscribe('Reader', 'onReceive', viaName);
    stop();
    SerialBroker.unsubscribe('Reader', 'onReceive', viaName);

    platform.device.emit('x');
    await settle();

    expect(viaReturn).not.toHaveBeenCalled();
    expect(viaName).not.toHaveBeenCalled();
  });

  it('releases everything it holds', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await settle();

    await SerialBroker.releaseAll();

    expect(SerialBroker.names()).toEqual([]);
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

    expect(records.some(([, message]) => message.includes('configuration registered'))).toBe(true);
    // Every record carries the fields that let several tabs be correlated in one console.
    expect(records[0]?.[2]).toHaveProperty('clientId');

    SerialBroker.configure({});
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

    SerialBroker.configure({ logPayloads: false });
  });

  it('answers what is set up without building anything, even without Web Serial', async () => {
    await SerialBroker.dispose();
    vi.stubGlobal('navigator', {});

    expect(SerialBroker.exists('Reader')).toBe(false);
    expect(SerialBroker.names()).toEqual([]);
    await expect(SerialBroker.release('Reader')).resolves.toBeUndefined();
    await expect(SerialBroker.releaseAll()).resolves.toBeUndefined();
  });

  it('rebuilds itself after being disposed', async () => {
    await SerialBroker.setup('Reader', READER_OPTIONS);
    await SerialBroker.dispose();

    await SerialBroker.setup('Reader', READER_OPTIONS);

    expect(SerialBroker.exists('Reader')).toBe(true);
  });
});
