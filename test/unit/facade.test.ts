import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { LogFields, Logger, LogLevel } from '../../src/core/types.js';
import { SerialBrokerStatus } from '../../src/core/types.js';
import { SerialBroker } from '../../src/serial-broker.js';

const DEVICE = { vendorId: 0x1a86, productId: 0x7523 };
const OPTIONS = { device: DEVICE, serial: { baudRate: 9600 } };

/**
 * The zero-argument singleton an application actually imports.
 *
 * It is thin by design - it builds the environment lazily and delegates - but "thin" is not
 * "correct": the lazy construction, the global options, and the fact that merely importing
 * the module must not touch a global are all behaviour worth pinning down.
 */

/** A minimal but faithful stand-in for the platform, good enough to open one port. */
function stubPlatform(): { written: Uint8Array[]; emit: (bytes: Uint8Array) => void } {
  const written: Uint8Array[] = [];
  let push: (bytes: Uint8Array) => void = () => undefined;

  const port = {
    getInfo: () => ({ usbVendorId: DEVICE.vendorId, usbProductId: DEVICE.productId }),
    readable: null as ReadableStream<Uint8Array> | null,
    writable: null as WritableStream<Uint8Array> | null,
    open: async (): Promise<void> => {
      port.readable = new ReadableStream<Uint8Array>({
        start: (controller) => {
          push = (bytes) => controller.enqueue(bytes);
        },
      });
      port.writable = new WritableStream<Uint8Array>({
        write: (chunk) => {
          written.push(new Uint8Array(chunk));
        },
      });
      await Promise.resolve();
    },
    close: async (): Promise<void> => {
      port.readable = null;
      port.writable = null;
      await Promise.resolve();
    },
    forget: async (): Promise<void> => await Promise.resolve(),
  };

  vi.stubGlobal('navigator', {
    serial: {
      getPorts: async () => await Promise.resolve([port]),
      requestPort: async () => await Promise.resolve(port),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    locks: {
      request: async <T>(
        _name: string,
        _options: unknown,
        callback: (lock: unknown) => Promise<T>,
      ): Promise<T> => await callback({ name: _name, mode: 'exclusive' }),
    },
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

  return { written, emit: (bytes) => push(bytes) };
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
    await SerialBroker.setup('Reader', OPTIONS);
    await settle();

    const received: string[] = [];
    SerialBroker.subscribe('Reader', 'onReceive', (event) => {
      received.push(new TextDecoder().decode(event.data));
    });

    await SerialBroker.send('Reader', 'PING');
    platform.emit(new TextEncoder().encode('PONG'));
    await settle();

    expect(SerialBroker.getStatus('Reader').status).toBe(SerialBrokerStatus.Open);
    expect(new TextDecoder().decode(platform.written[0])).toBe('PING');
    expect(received).toEqual(['PONG']);
  });

  it('answers questions about what is set up', async () => {
    await SerialBroker.setup('Reader', OPTIONS);

    expect(SerialBroker.exists('Reader')).toBe(true);
    expect(SerialBroker.exists('Other')).toBe(false);
    expect(SerialBroker.names()).toEqual(['Reader']);
  });

  it('removes a listener through the returned function and through unsubscribe', async () => {
    await SerialBroker.setup('Reader', OPTIONS);
    await settle();
    const viaReturn = vi.fn();
    const viaName = vi.fn();

    const stop = SerialBroker.subscribe('Reader', 'onReceive', viaReturn);
    SerialBroker.subscribe('Reader', 'onReceive', viaName);
    stop();
    SerialBroker.unsubscribe('Reader', 'onReceive', viaName);

    platform.emit(new TextEncoder().encode('x'));
    await settle();

    expect(viaReturn).not.toHaveBeenCalled();
    expect(viaName).not.toHaveBeenCalled();
  });

  it('releases everything it holds', async () => {
    await SerialBroker.setup('Reader', OPTIONS);
    await settle();

    await SerialBroker.releaseAll();

    expect(SerialBroker.names()).toEqual([]);
  });

  it('restores a configuration persisted earlier', async () => {
    await SerialBroker.setup('Reader', OPTIONS);
    await settle();
    await SerialBroker.dispose();

    await expect(SerialBroker.restore()).resolves.toEqual(['Reader']);
  });

  it('grants access when the user picks the configured device', async () => {
    await SerialBroker.setup('Reader', OPTIONS);
    await settle();

    await expect(SerialBroker.requestAccess('Reader')).resolves.toBe(true);
  });

  it('rejects an operation on a configuration that is not set up', () => {
    expect(() => SerialBroker.getStatus('Nothing')).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.UNKNOWN_CONFIGURATION }),
    );
  });

  it('passes a configured logger through to the library', async () => {
    const records: [LogLevel, string, LogFields][] = [];
    const logger: Logger = {
      log: (level, message, fields) => records.push([level, message, fields]),
    };

    SerialBroker.configure({ logger });
    await SerialBroker.setup('Reader', OPTIONS);
    await settle();

    expect(records.some(([, message]) => message.includes('configuration registered'))).toBe(true);
    // Every record carries the fields that let several tabs be correlated in one console.
    expect(records[0]?.[2]).toHaveProperty('clientId');

    SerialBroker.configure({});
  });

  it('passes logPayloads through, so traffic records carry the bytes', async () => {
    const records: LogFields[] = [];
    const logger: Logger = {
      log: (_level, _message, fields) => records.push(fields),
    };

    SerialBroker.configure({ logger, logPayloads: true });
    await SerialBroker.setup('Reader', OPTIONS);
    await settle();
    platform.emit(new TextEncoder().encode('PONG'));
    await settle();

    expect(records.find((fields) => fields.event === 'supervisor.received')).toMatchObject({
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
    await SerialBroker.setup('Reader', OPTIONS);
    await SerialBroker.dispose();

    await SerialBroker.setup('Reader', OPTIONS);

    expect(SerialBroker.exists('Reader')).toBe(true);
  });
});
