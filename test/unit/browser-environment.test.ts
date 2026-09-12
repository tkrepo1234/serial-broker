import { afterEach, describe, expect, it, vi } from 'vitest';

import { SerialBrokerErrorCode } from '../../src/core/error-codes.js';
import type { SerialBrokerError } from '../../src/core/errors.js';
import { NOOP_LOGGER, ScopedLogger } from '../../src/core/logger.js';
import { createBrowserEnvironment, isSupported } from '../../src/environment/browser.js';
import type { ClientId } from '../../src/protocol/messages.js';

/**
 * The composition root, which is the one file allowed to read a global.
 *
 * Everything here is about what happens in an unusual browser: no Web Serial, no
 * `SharedWorker`, a `localStorage` that throws on access. These are the paths that decide
 * whether a user sees a working feature or a broken page, and none of them can be reached
 * through the injected environment the rest of the suite uses.
 */

const globals = globalThis as Record<string, unknown>;

function stubBrowser(
  overrides: {
    hasSerial?: boolean;
    hasLocks?: boolean;
    sharedWorker?: 'working' | 'throwing' | 'absent';
    broadcastChannel?: boolean;
    storage?: 'working' | 'throwing';
  } = {},
): void {
  const {
    hasSerial = true,
    hasLocks = true,
    sharedWorker = 'working',
    broadcastChannel = true,
    storage = 'working',
  } = overrides;

  const navigatorStub: Record<string, unknown> = {};
  if (hasSerial) {
    navigatorStub['serial'] = {
      getPorts: async () => [],
      requestPort: async () => ({}),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  }
  if (hasLocks) {
    navigatorStub['locks'] = { request: async () => undefined };
  }
  vi.stubGlobal('navigator', navigatorStub);

  if (sharedWorker === 'absent') {
    vi.stubGlobal('SharedWorker', undefined);
  } else {
    vi.stubGlobal(
      'SharedWorker',
      class {
        port = {
          postMessage: () => undefined,
          start: () => undefined,
          close: () => undefined,
          addEventListener: () => undefined,
        };
        addEventListener = (): void => undefined;
        constructor() {
          if (sharedWorker === 'throwing') {
            throw new Error('Refused to create a worker: CSP');
          }
        }
      },
    );
  }

  vi.stubGlobal(
    'BroadcastChannel',
    broadcastChannel
      ? class {
          postMessage = (): void => undefined;
          close = (): void => undefined;
          addEventListener = (): void => undefined;
        }
      : undefined,
  );

  const entries = new Map<string, string>();
  vi.stubGlobal(
    'localStorage',
    storage === 'working'
      ? {
          getItem: (key: string) => entries.get(key) ?? null,
          setItem: (key: string, value: string) => entries.set(key, value),
          removeItem: (key: string) => entries.delete(key),
        }
      : {
          getItem: () => {
            throw new Error('denied');
          },
          setItem: () => {
            throw new Error('denied');
          },
          removeItem: () => {
            throw new Error('denied');
          },
        },
  );
}

/** Everything a transport needs, with the callbacks stubbed out. */
function transportRequest(): Parameters<
  ReturnType<typeof createBrowserEnvironment>['createTransport']
>[0] {
  return {
    clientId: 'c-1' as ClientId,
    onMessage: () => undefined,
    onDecodeFailure: () => undefined,
    onTransportError: () => undefined,
    logger: new ScopedLogger(NOOP_LOGGER, {}),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete globals['navigator'];
});

describe('isSupported', () => {
  it('is true when the platform has everything the library needs', () => {
    stubBrowser();

    expect(isSupported()).toBe(true);
  });

  it('is false without Web Serial', () => {
    stubBrowser({ hasSerial: false });

    expect(isSupported()).toBe(false);
  });

  it('is false without Web Locks', () => {
    stubBrowser({ hasLocks: false });

    expect(isSupported()).toBe(false);
  });
});

describe('createBrowserEnvironment', () => {
  it('refuses to build without Web Serial, naming the reason', () => {
    stubBrowser({ hasSerial: false });

    try {
      createBrowserEnvironment();
      expect.unreachable();
    } catch (error) {
      expect((error as SerialBrokerError).code).toBe(SerialBrokerErrorCode.WEB_SERIAL_UNAVAILABLE);
      expect((error as SerialBrokerError).remediation).toContain('secure context');
    }
  });

  it('refuses to build without Web Locks', () => {
    stubBrowser({ hasLocks: false });

    expect(() => createBrowserEnvironment()).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.WEB_LOCKS_UNAVAILABLE }),
    );
  });

  it('prefers the SharedWorker transport', () => {
    stubBrowser();

    const transport = createBrowserEnvironment({
      workerUrl: 'https://example.test/w.js',
    }).createTransport(transportRequest());

    expect(transport.kind).toBe('sharedworker');
  });

  it('falls back to BroadcastChannel when SharedWorker is absent', () => {
    stubBrowser({ sharedWorker: 'absent' });

    // Chrome for Android has no SharedWorker but does have Web Serial. Failing there would
    // mean no device access at all, for a coordination detail the fallback handles (ADR-0007).
    expect(createBrowserEnvironment().createTransport(transportRequest()).kind).toBe(
      'broadcastchannel',
    );
  });

  it('falls back when constructing a SharedWorker throws', () => {
    stubBrowser({ sharedWorker: 'throwing' });

    // A strict script-src CSP produces exactly this.
    expect(createBrowserEnvironment().createTransport(transportRequest()).kind).toBe(
      'broadcastchannel',
    );
  });

  it('reports a failure instead of falling back when a transport was demanded', () => {
    stubBrowser({ sharedWorker: 'throwing' });

    expect(() =>
      createBrowserEnvironment({ transport: 'sharedworker' }).createTransport(transportRequest()),
    ).toThrow(expect.objectContaining({ code: SerialBrokerErrorCode.BROKER_UNAVAILABLE }));
  });

  it('uses BroadcastChannel when it is demanded', () => {
    stubBrowser();

    expect(
      createBrowserEnvironment({ transport: 'broadcastchannel' }).createTransport(
        transportRequest(),
      ).kind,
    ).toBe('broadcastchannel');
  });

  it('reports that no transport is available when neither exists', () => {
    stubBrowser({ sharedWorker: 'absent', broadcastChannel: false });

    expect(() => createBrowserEnvironment().createTransport(transportRequest())).toThrow(
      expect.objectContaining({ code: SerialBrokerErrorCode.TRANSPORT_UNAVAILABLE }),
    );
  });

  it('degrades to in-memory storage rather than failing when localStorage throws', () => {
    stubBrowser({ storage: 'throwing' });

    const environment = createBrowserEnvironment();
    environment.storage.setItem('k', 'v');

    // A private window or a sandboxed iframe costs the application persistence, not the
    // device. Everything keeps working; only a reload forgets.
    expect(environment.storage.getItem('k')).toBe('v');
  });

  it('produces identifiers that do not repeat', () => {
    stubBrowser();
    const environment = createBrowserEnvironment();

    const ids = new Set([1, 2, 3, 4, 5].map(() => environment.newId('c')));

    expect(ids.size).toBe(5);
  });

  it('produces a clock that measures real time and cancels its timers', async () => {
    stubBrowser();
    const clock = createBrowserEnvironment().clock;

    expect(clock.now()).toBeGreaterThan(1_600_000_000_000);

    let fired = false;
    const handle = clock.setTimer(() => {
      fired = true;
    }, 1);
    clock.clearTimer(handle);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(fired).toBe(false);
  });

  it('produces jitter within the documented range', () => {
    stubBrowser();
    const environment = createBrowserEnvironment();

    for (let round = 0; round < 20; round += 1) {
      const value = environment.random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
